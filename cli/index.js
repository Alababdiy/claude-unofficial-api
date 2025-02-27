#!/usr/bin/env node

import { Claude } from '../index.js';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import * as marked from 'marked';
import TerminalRenderer from 'marked-terminal';
import meow from 'meow';
import { exists, existsSync, mkdirSync, readFileSync, writeFile, writeFileSync } from 'fs';
import "dotenv/config";
import mime from 'mime-types';
import { homedir } from 'os';
import { dirname, join, sep } from 'path';
import "isomorphic-fetch";
import { File } from "@web-std/file";

marked.setOptions({ headerIds: false, mangle: false })
marked.setOptions({
    renderer: new TerminalRenderer(),
});

const HELP = `${chalk.bold.white("Usage")}:
!exit    Exit the program
!help    Show this message
!clear   Clear the console
!retry   Retry the last message
!files   Show the list of files uploaded to this conversation
!convos  List conversations

(Also works with single word commands like "exit", "help" or "clear")`

const cli = meow(`
  Usage
    $ claude [options]

  Options
    ${chalk.bold.white("--conversation-id")}  Conversation ID to continue
    ${chalk.bold.white("--json")}             Print response as JSON
    ${chalk.bold.white("--files")}            Comma-separated list of files to attach
    ${chalk.bold.white("--help")}             Show this message
    ${chalk.bold.white("--model")}            Claude model to use
    ${chalk.bold.white("--sync")}             Output the conversation synchronously (don't render progress)
    ${chalk.bold.white("--markdown")}         Whether to render markdown in the terminal (defaults to true)
    ${chalk.bold.white("--key")}              Path to a text file containing the sessionKey cookie value from https://claude.ai
    ${chalk.bold.white("--template")}         A prompt template text file
    ${chalk.bold.white("--clear")}            Clear all conversations (no confirmation)
    ${chalk.bold.white("--prompt.___")}       Define custom variables for templates (e.g. ${chalk.italic('--prompt.schema schema.d.ts')}, used as {schema} in templates)
  
  Examples
    $ claude --conversation-id fc6d1a1a-8722-476c-8db9-8a871c121ee9
    $ claude --json
    $ claude --files file1.txt,file2.txt
    $ echo "hello world" | claude
    $ echo "Tell me a joke and write it to joke.txt" | claude --template ./joke.txt
`, {
    importMeta: import.meta,
    flags: {
        markdown: {
            type: 'boolean',
            default: true,
            shortFlag: 'md',
        },
        conversationId: {
            type: 'string',
            shortFlag: 'c',
        },
        json: {
            type: 'boolean',
            default: false,
            shortFlag: 'j',
        },
        files: {
            type: 'string',
            shortFlag: 'f',
        },
        model: {
            type: 'string',
            choices: ['claude-2', 'claude-instant-100k', 'claude-1', 'claude-1.3'],
            default: 'claude-2',
            shortFlag: 'm',
        },
        sync: {
            type: 'boolean',
            default: false,
            shortFlag: 's',
        },
        key: {
            type: 'string',
            default: '~/.claude_key',
            shortFlag: 'k',
        },
        template: {
            type: 'string',
            shortFlag: 't',
        },
        prompt: {
            type: 'string',
            shortFlag: 'p',
            isRequired: false,
            isMultiple: true,
        }
    }
});

const WELCOME_MESSAGE = chalk.bold.green('Welcome to the Claude CLI!');

let MODEL = 'claude-2'
const claude = new Claude({
    sessionKey: getKey(),
    fetch: globalThis.fetch
});

async function main() {
    const { flags } = cli;
    await claude.init();
    MODEL = cli.flags.model;
    if (cli.flags.clear) {
        try {
            await claude.clearConversations();
        } catch (e) {
            console.error(chalk.bold.red('Error clearing conversations!'));
            EXIT(1);
        }
        console.log(chalk.green.bold('Cleared conversations'))
        EXIT(0);
    }
    if (cli.input.length || !process.stdin.isTTY) {
        let message;
        if (!cli.input.length) {
            message = await getStdin(1000);
        } else {
            message = cli.input.join(' ')
        }
        if (!message?.trim()?.length) {
            message = getPromptInput().prompts[0];
        }
        if (!message?.trim()?.length) {
            console.error(chalk.red.bold('No message provided!'));
            EXIT(0);
        }
        const info = {
            convos: []
        }
        let params = {
            model: MODEL,
            done: (a) => {
                EXIT(0);
            },
            attachments: [],
        };
        if (flags.files) {
            for (let fileName of flags.files.trim().split(',').map(i => i.trim())) {
                const fileContent = await uploadFile(claude, fileName);
                params.attachments.push(fileContent);
            }
        }
        const r = await getFiles(message, claude);
        params.attachments.push(...r.attachments);
        message = r.question;

        params = await template(message, status(params))
        if (cli.flags.template) { EXIT(0) }

        if (flags.conversationId) {
            info.convos = await claude.getConversations();
            info.conversation = info.convos.find(c => c.id === flags.conversationId || c.name === flags.conversationId);
            if (!info.conversation) {
                console.error(chalk.red.bold('Conversation not found:'))
                console.log(chalk.dim.gray(info.convos.map(i => `${i.name} (${i.id})`).join('\n')));
                EXIT(1);
            }
            info.conversation.sendMessage(...params)
        } else {
            await claude.startConversation(...params)
        }
    } else {
        console.log(WELCOME_MESSAGE);
        SPINNER = ora('Loading conversations...').start();
        const conversations = await claude.getConversations().then(c => c.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
        SPINNER.stop();

        const conversationOptions = [
            { name: 'Start new conversation', value: 'start_new' },
            { name: 'Export conversations', value: 'export' },
            { name: 'Clear conversations', value: 'clear' },
            ...(conversations.length ? [new inquirer.Separator()] : []),
            ...conversations.map(c => ({ name: c.name || chalk.dim.italic('No name'), value: c.name })),
        ];

        const { conversation } = await inquirer.prompt({
            name: 'conversation',
            type: 'list',
            message: 'Select a conversation:',
            choices: conversationOptions,
            loop: false,
        });

        if (conversation === 'export') {
            const { answer } = await inquirer.prompt({
                name: 'answer',
                type: 'checkbox',
                message: 'Export format',
                choices: [{ name: 'JSON', value: 'json' }, { name: 'Markdown', value: 'markdown' }, { name: 'HTML', value: 'html' }],
            })
            if (!existsSync('claude-conversations')) { mkdirSync('claude-conversations'); }
            const conversations = await claude.getConversations();
            await Promise.all(conversations.map(async (convo) => {
                const info = await convo.getInfo();
                if (answer.includes('json')) {
                    const filename = `${formatName(info.name)}-${convo.conversationId}.json`;
                    writeFileSync(join('claude-conversations', filename), JSON.stringify(info, null, 2))
                    console.log(chalk.bold.blue(`Exported ${convo.conversationId} (${convo.name}) conversation to ` + chalk.bold.white(filename)))
                }
                if (answer.includes('markdown')) {
                    const filename = `${formatName(info.name)}-${convo.conversationId}.md`;
                    writeFileSync(join('claude-conversations', filename), `---\ncreated_at: ${info.created_at}\nupdated_at: ${info.updated_at}\ntitle: ${info.name}\nuuid: ${info.uuid}\n---\n\n# ${info.name}\n_Created at ${new Date(info.created_at).toLocaleDateString('en-US', {
                        month: '2-digit',
                        day: '2-digit',
                        year: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                    })} - \`${info.uuid}\`_\n\n${info.chat_messages.map(i => {
                        return `## **${i.sender === 'human' ? "User" : "Claude"}**\n\n_(${new Date(i.created_at).toLocaleDateString('en-US', {
                            month: '2-digit',
                            day: '2-digit',
                            year: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                        })})_\n\n${i.text}${i.attachments ? '\n\n' : ''}${i.attachments.map(j => {
                            return `<details>\n<summary>${j.file_name} (${formatBytes(j.file_size)})</summary>\n\n\n\`\`\`${j.file_name.split('.').slice(-1)[0]}\n${j.extracted_content}\n\`\`\`\n\n\n</details>`;
                        }).join('\n')}`;
                    }).join('\n\n\n\n')}`);
                    console.log(chalk.bold.blue(`Exported ${convo.conversationId} (${convo.name}) conversation to ` + chalk.bold.white(filename)))
                }
                if (answer.includes('html')) {
                    const filename = `${formatName(info.name)}-${convo.conversationId}.html`;
                    writeFileSync(join('claude-conversations', filename), readFileSync(join(dirname(import.meta.url.replace('file:/', '')), 'html_template.html'), 'utf-8').replace('{TITLE}', info.name).replace('"{CONVERSATION}"', JSON.stringify(info)));
                    console.log(chalk.bold.blue(`Exported ${convo.conversationId} (${convo.name}) conversation to ` + chalk.bold.white(filename)))
                }
                function formatName(name) {
                    return name.slice(0, 25).toLowerCase().replace(/[^a-z0-9]+/g, '-');
                }
            }))
            EXIT(0);
        }

        if (conversation === 'clear') {
            const { answer } = await inquirer.prompt({
                name: 'answer',
                type: 'confirm',
                message: 'Are you sure you want to clear conversations?',
                default: false,
                choices: [{ name: 'Yes', value: true }, { name: 'No', value: false }],
                loop: false,
            })
            if (!answer) { console.error(chalk.bold.red('Aborting')); EXIT(0); }
            SPINNER.text = 'Clearing conversations...';
            SPINNER.start();
            await claude.clearConversations();
            SPINNER.text = 'Done';
            SPINNER.stop();
            console.log(chalk.bold.green('Done!'));
            EXIT(0);
        }

        let selectedConversation;

        if (conversation !== 'start_new') {
            selectedConversation = conversations.find(c => c.name === conversation);
        }

        while (true) {

            let { question } = await inquirer.prompt({
                name: 'question',
                type: 'input',
                message: chalk.dim.gray(`(${MODEL})`) + chalk.bold.cyan(' >'),
            });
            if (!question.trim()?.length) {
                continue;
            }
            if (question.startsWith('!')) {
                question = question.replace("!", "")
            }
            const tq = question.trim().toLowerCase();
            if (tq === 'help') {
                console.log(HELP);
                continue;
            }
            if (tq === 'convos') {
                setTimeout(() => (console.clear(), main()));
                return;
            }
            if (tq === 'clear') {
                console.clear();
                console.log(chalk.dim.italic.gray("Cleared console"))
                continue;
            }
            if (tq === 'export') {
                const filename = `conversation-${selectedConversation.conversationId}.json`;
                writeFileSync(filename, JSON.stringify(await selectedConversation.getInfo(), null, 2))
                console.log(chalk.bold.blue('Exported current conversation to ' + chalk.bold.white(filename)))
                continue;
            }
            if (tq === 'exit' || tq === 'quit') {
                EXIT(0);
            }
            if (tq === 'delete') {
                let sp = ora('Deleting conversation...').start();
                await selectedConversation.delete();
                sp.stop();
                setTimeout(() => (console.clear(), main()));
                return;
            }
            if (tq === 'files') {
                if (!selectedConversation) {
                    console.error(chalk.red.bold('No conversation selected'));
                    continue;
                }
                const messages = await selectedConversation.getMessages();
                const attachments = messages.map(i => i.attachments).flat();
                if (!attachments?.length) {
                    console.log(chalk.bold.italic.blue('No files uploaded yet!') + '\n\n' + chalk.gray.dim('Examples of uploading a file:\n\n' + chalk.bold.white('Find some trends in [data.csv]') + '\n\nOr:\n\n' + chalk.bold.white('claude --files file1.txt,file2.txt')));
                    continue;
                }
                const TABLE = '| File Name | Size | Tokens | Created At |\n|-|-|-|-|\n' + attachments.map(i => `| ${chalk.bold.white(i.file_name)} ${chalk.dim.gray.italic(`(${i.file_type})`)} | ${chalk.yellowBright(formatBytes(i.file_size))} | ${chalk.dim.blue("~ " + Math.round(i.extracted_content.length / 4) + " tokens")} | ${i.created_at} | `).join('\n') + `\n| ${chalk.gray.dim.italic('Total: ' + attachments.length + ' file' + (attachments.length > 1 ? 's' : ''))} | ${chalk.yellowBright(formatBytes(attachments.reduce((a, b) => a + b.file_size, 0)))} | ${chalk.dim.blue('~ ' + Math.round(attachments.reduce((a, b) => a + b.extracted_content.length / 4, 0)) + ' tokens')} |  |\n`;
                console.log(md(TABLE));
                continue;
            }
            console.log(chalk.gray.dim.italic('Asking claude'));
            const params = {
                attachments: [],
            }
            if (tq === 'retry') {
                params.retry = true
                question = "";
            }
            const r = await getFiles(question, claude);
            question = r.question;
            params.attachments = r.attachments;
            let res;
            if (!selectedConversation) {
                res = await template(question, status({
                    MODEL,
                    ...params,
                }));
                if (!cli.flags.template) {
                    selectedConversation = await claude.startConversation(...res);
                } else {
                    selectedConversation = res[2];
                }
            } else {
                if (!res) {
                    res = await template(question, status({
                        MODEL,
                        ...params,
                    }))
                } else {
                    res = [
                        question,
                        status({
                            MODEL,
                            ...params,
                        }),
                        ...res.slice(2)
                    ]
                }
                await selectedConversation.sendMessage(...res)
                // runEveries
                if (res[3]?.length) {
                    res[3]();
                }
            }
            SPINNER.stop();
            SPINNER.clear();
        }
    }
}

function md(text) {
    return marked.parse(text?.trim() || '')?.trim();
}

function getKey() {
    const START_SEQ = 'sk-ant-sid01';
    if (cli.flags.key.startsWith(START_SEQ)) {
        return cli.flags.key;
    }
    let key;
    if (process.env.CLAUDE_KEY) {
        key = process.env.CLAUDE_KEY;
    }
    try {
        key = readFileSync(cli.flags.key.replace(`~`, homedir()), 'utf-8').trim()
    } catch (e) { }
    if (!key || !key.startsWith(START_SEQ)) {
        if (!key) {
            console.error(chalk.red.bold('Error: No sessionKey cookie'));
            EXIT(1);
        }
        key = getCookie(key, key);
    }
    if (!key || !key.startsWith(START_SEQ)) {
        console.error(chalk.red.bold('Error: No sessionKey cookie'));
        EXIT(1);
    }
    return key.trim();
}

function getCookie(name, cookie) {
    function escape(s) { return s.replace(/([.*+?\^$(){}|\[\]\/\\])/g, '\\$1'); }
    var match = cookie.match(RegExp('(?:^|;\\s*)' + escape(name) + '=([^;]*)'));
    return match ? match[1] : null;
}

async function uploadFile(claude, filename) {
    if (!existsSync(filename)) {
        console.error(chalk.red.bold(`Error: File not found: ${filename}`));
        EXIT(1);
    }
    console.log(chalk.gray.dim.italic('Uploading file ' + filename));
    const attachment = await claude.uploadFile(
        new File([readFileSync(filename)], filename.split('/').slice(-1)[0], { type: mime.lookup(filename) })
    );
    console.log(chalk.gray.dim.italic('Uploaded file ' + filename));
    return attachment;
}

async function getFiles(text, claude) {
    let attachments = [];
    let question = text;
    const regex = /\[([^\]]+)]/g;
    let match;
    while (match = regex.exec(question)) {
        const filename = match[1];
        attachments.push(await uploadFile(claude, filename));
        question = question.replace(match[0], `the uploaded file ${filename}`);
    }
    return { attachments, question }
}

// https://stackoverflow.com/a/42408230
function formatBytes(n) {
    const k = n > 0 ? Math.floor((Math.log2(n) / 10)) : 0;
    const rank = (k > 0 ? 'KMGT'[k - 1] : '') + 'b';
    const count = Math.floor(n / Math.pow(1024, k));
    return count + rank;
}

async function getStdin(timeout = 500) {
    return new Promise((resolve, reject) => {
        let input = '';

        process.stdin.on('data', (chunk) => {
            input += chunk;
        });

        process.stdin.on('error', (err) => {
            reject(err);
        });

        let timer = setTimeout(() => {
            reject(new Error('Timeout exceeded waiting for stdin'));
        }, timeout);

        process.stdin.on('end', () => {
            clearTimeout(timer);
            resolve(input);
        });
    });
}

let SPINNER;
function status(params, options) {
    const SILENT = cli.flags.sync || options?.silent;
    if ((!SPINNER || !SPINNER.isSpinning) && !SILENT) {
        if (SPINNER) {
            SPINNER.stop();
            SPINNER.clear();
        }
        SPINNER = ora('Generating...').start();
    }
    return {
        ...params,
        progress(a) {
            let result;
            if (params.progress && !SILENT) {
                result = params.progress(a)
            }
            if (result?.skip) { return };
            if (SPINNER && a.completion && !SILENT) {
                SPINNER.text = chalk.gray.dim('Generating...\n\n' + md(a.completion));
            }
        },
        done(a) {
            if (SPINNER) {
                SPINNER.stop();
                SPINNER.clear();
            }
            if (!a.completion) {
                console.error(chalk.red.bold('Error: No response'));
                EXIT(1);
            }
            if (a.completion && !options?.clear && !SILENT) {
                console.log(cli.flags.json ? JSON.stringify(a) : cli.flags.markdown ? md(a.completion) : a.completion);
            }
            if (params.done) {
                params.done(a);
            }
        }
    }
}

async function template(message, params) {
    if (cli.flags.template) {
        let templateText;
        let templatePath;
        if (existsSync(cli.flags.template)) {
            templatePath = cli.flags.template;
        } else if (existsSync(join(dirname(import.meta.url.replace('file:/', '')), 'templates', cli.flags.template))) {
            templatePath = join(dirname(import.meta.url.replace('file:/', '')), 'templates', cli.flags.template);
        } else if (existsSync(join(dirname(import.meta.url.replace('file:/', '')), 'templates', cli.flags.template + '.txt'))) {
            templatePath = join(dirname(import.meta.url.replace('file:/', '')), 'templates', cli.flags.template + '.txt');
        } else {
            console.error(chalk.red.bold('No template found'));
            EXIT(1);
        }
        try {
            templateText = readFileSync(templatePath, 'utf-8');
        } catch (e) {
            console.error(chalk.red.bold('No template found'));
            EXIT(1);
        }
        if (!templateText) {
            console.error(chalk.red.bold('No template found'))
            EXIT(1);
        }
        const PROMPTINPUT = getPromptInput();
        let prompt = await getPrompt(templateText, {
            ...PROMPTINPUT,
            prompt: message,
            templatePath
        });
        prompt.attachments = [...(params.attachments || []), ...(prompt.attachments || [])];
        delete params.attachments;
        prompt = {
            ...params,
            ...prompt,
        }
        const result = await runPrompt(prompt);
        let out = { ...params };
        if (result.attachments) {
            out.attachments = out.attachments || [];
            out.attachments.push(...result.attachments);
        }
        return [result.body, out, result.conversation, result.runEveries];
    } else {
        return [message, params, null, null];
    }
}

function getPromptInput() {
    const PARAMS = {};
    let f = cli.flags.prompt;
    if (typeof f !== 'array') {
        f = [f];
    }
    for (let val of f) {
        if (typeof val === 'object') {
            Object.assign(PARAMS, val);
        } else {
            PARAMS.prompts = Array.isArray(PARAMS.prompts) ? PARAMS.prompts : [] || [];
            PARAMS.prompts.push(val);
        }
    }
    for (let [k, v] of Object.entries(PARAMS)) {
        try {
            if (existsSync(v)) {
                PARAMS[k] = readFileSync(v, 'utf-8');
            }
        } catch (e) { }
    }
    return PARAMS;
}

function callClaude(prompt) {
    return claude.sendMessage(prompt, status({
        temporary: false,
    }, { clear: true }))
}

/**
 * Finds and replaces all occurrences of a regular expression in a given string
 * using a callback function.
 *
 * @param {RegExp} regex - The regular expression to search for.
 * @param {string} string - The string to search within.
 * @param {Function} callback - The callback function that will be called for each match.
 * @return {Array} An array containing the replaced string segments.
 */
async function findReplace(regex, string, callback) {
    let out = [];
    if (typeof string === 'string') {
        string = [string];
    }
    for (let str of string) {
        if (typeof str !== 'string') { out.push(str); continue; }
        if (str.length === 0) { out.push(str); continue; }
        let match;
        let prevIndex = 0;
        while ((match = regex.exec(str)) !== null) {
            out.push(str.slice(prevIndex, match.index));
            out.push(await callback(match, str));
            prevIndex = match.index + match[0].length;
        }
        out.push(str.slice(prevIndex, str.length));
    }
    return out;
}

async function getPrompt(template, variables = {}) {
    const RE = {
        block: /{#(?<command>[a-z]+)(?: (?:(?<var>\w+)=)?(?<param>.+?))?}\s*(?<body>[\s\S]+?)\s*{\/(?<endcmd>\1)}/g,
        inline_command: /{#(?<command>[a-z]+)(?:\s+(?:(?<var>\w+)=)?(?<input>".+"))?\/?}/g,
        var_read: /{(?<name>[\w_]+)}/g,
        var_write: /{(?<var>[\w_]+)=(?<value>[^}]+)}/g,
    }
    let out = template;
    out = await findReplace(RE.block, out, async (a) => {
        if (a.groups.command !== a.groups.endcmd) {
            throw new Error('Unexpected command end: ' + a.groups.command + '!=' + a.groups.endcmd);
        }
        return {
            type: 'block',
            command: a.groups.command,
            param: a.groups.param,
            var: a.groups.var,
            body: a.groups.body,
        }
    })
    out = await findReplace(RE.inline_command, out, async (a) => {
        return {
            type: 'command',
            command: a.groups.command,
            value: a.groups.input,
            var: a.groups.var,
        }
    })
    out = await findReplace(RE.var_write, out, async (a) => {
        return {
            type: 'variable_set',
            name: a.groups.var,
            value: a.groups.value,
        }
    })
    out = await findReplace(RE.var_read, out, async (a) => {
        return {
            type: 'variable',
            name: a.groups.name,
        }
    })
    let promptText = '';
    let attachments = [];
    let followup = [];
    // Commands which run after every response
    let every = [];
    for (const block of out) {
        if (typeof block === 'string') {
            if (!block.trim().length) { promptText += '\n'; continue }
            promptText += block;
            continue;
        }
        if (block.type === 'variable') {
            promptText += variables[block.name];
        }
        if (block.type === 'variable_set') {
            variables[block.name] = block.value;
        }
        let result = {};
        if (block.type === 'command') {
            try {
                block.value = JSON.parse(block.value);
            } catch (e) { }
            // TODO: interpret inline commands
            if (block.command === 'import') {
                console.log(variables.templatePath);
                block.body = join(variables.templatePath.split(sep).slice(0, -1).join(sep), block.value);
                block.body = readFileSync(block.body, 'utf-8');
                let ran = await getPrompt(block.body, variables);
                result = ran;
            } else {
                result = await runCommand(block.command, variables, simpleVarReplace(block.value));
                if (block.var) { result.body = ''; }
            }
        }
        if (block.type === 'block') {
            if (['followup', 'every'].includes(block.command)) {
                result = await runCommand(block.command, variables, block.body, block.param);
            } else {
                const ran = await getPrompt(block.body, variables);
                Object.assign(variables, ran.variables);
                attachments.push(...ran.attachments);
                followup.push(...ran.followup);
                result = await runCommand(block.command, variables, ran.body, block.param);
            }
        }
        if (block.command === 'claude') {
            if (SPINNER) { SPINNER.stop(); SPINNER.clear(); }
            console.log(chalk.gray.dim(("Claude response finished: " + (result.body || "").toString().slice(0, 100))));
        }
        result = { body: '', variables: {}, ...result }
        promptText += result.body;
        variables.response = result.value || result.body;
        variables.result = result.value || result.body;
        Object.assign(variables, result.variables);
        if (block.var) {
            variables[block.var] = variables.response;
        }
        if (result.attachments) {
            attachments.push(...result.attachments);
        }
        if (result.every) {
            every.push(...result.every);
        }
        if (result.followup) {
            followup.push(...result.followup);
        }
    }
    promptText = promptText.replace(/\n+/g, '\n').replace(/ +/g, ' ');
    return { body: promptText, attachments, followup, variables, every };

    function simpleVarReplace(string) {
        return string.replace(RE.var_read, (_, varname) => {
            return variables[varname] || '';
        })
    }

    async function runCommand(command, variables = {}, arg, param) {
        if (command === "writefile") {
            writeFileSync(param, arg);
            return {
                value: arg, body: '',
            }
        }
        if (command === 'js' || ['jsdisplay', 'jsd'].includes(command)) {
            let pr;
            const BLACKLIST = ['void', 'var', 'let', 'const', 'private', 'public', 'window', 'body', 'document', 'globalThis', 'globals', 'import', 'class', 'async', 'function', 'this', 'return', 'yield', 'throw', 'catch', 'break', 'case', 'continue', 'default', 'do', 'else', 'finally', 'if', 'in', 'return', 'switch', 'throw', 'try', 'while', 'with', 'yield'];
            let p = new Promise(resolve => (pr = resolve));
            const EVAL_STR = (`((async ({${Object.keys(variables).filter(i => !BLACKLIST.includes(i)).join(', ')}}) => {
            ${arg.split('\n').length === 1 ? `return ${arg}` : arg}
        })(${JSON.stringify(variables)})).then(result => {
            pr(result);
        })`);
            eval(EVAL_STR);
            return await p.then((result) => {
                let out = { body: ['jsdisplay', 'jsd'].includes(command) ? result : '', value: result, variables: { js_response: result } };
                if (param) {
                    out.variables[param] = result;
                }
                return out;
            })
        }
        if (command === 'every') {
            return {
                every: [{ body: arg }]
            }
        }
        if (command === 'file') {
            const file = new Blob([arg], { type: 'text/plain' });
            return {
                value: arg, body: '', attachments: [{
                    file_name: param || `file-${Math.random().toString(16).slice(2).slice(0, 6)}.txt`,
                    file_type: 'text/plain',
                    file_size: file.size,
                    extracted_content: arg,
                }]
            }
        }
        if (command === 'followup') {
            return {
                followup: [{ body: arg }]
            }
        }
        if (command === 'claude') {
            const result = await callClaude(arg);
            return {
                body: result.completion,
                variables: {
                    claude_response: result,
                }
            }
        }
        return { body: `${command}(${arg})` }
    }
}

async function runPrompt(prompt) {
    prompt = {
        variables: {},
        body: '',
        followup: [],
        attachments: [],
        ...prompt,
    }
    let convo;
    if (!(prompt.body?.trim()?.length || prompt.every || prompt.followup)) { return; }
    if (!claude.ready) { await claude.init() }
    // Run the prompt
    if (prompt.dontRespond) {
        prompt.variables.response = prompt.body;
        prompt.variables.claude_response = { completion: prompt.body };
        prompt.conversation = {}
    } else if (prompt.body?.trim()?.length) {
        prompt.variables.claude_response = await new Promise(async resolve => {
            let r;
            let p = new Promise(res => (r = res));
            convo = await claude.startConversation(prompt.body, status({
                attachments: prompt.attachments,
                done(a) {
                    r(a);
                }
            }, { clear: !!prompt.variables.__clear || false, silent: !!prompt.variables.__silent }))
            const result = await p;
            resolve(result);
        })
        prompt.variables.response = prompt.variables.claude_response.completion;
        prompt.conversation = convo;
    }
    await runEveries();
    for (let i of prompt.followup) {
        const followup = await getPrompt(i.body, prompt.variables);
        prompt.followup.push(...followup.followup);
        prompt.every.push(...followup.every);
        if (!followup.body?.trim()?.length) { continue };
        prompt.variables.claude_response = await new Promise(r => {
            convo.sendMessage(followup.body, status({
                attachments: followup.attachments,
                done(a) {
                    r(a);
                }
            }, {
                clear: !!followup.variables.__clear || prompt.followup.indexOf(i) !== prompt.followup.length - 1,
                silent: !!followup.variables.__silent || !!prompt.variables.__silent || false,
            }))
        })
        await runEveries();
    }
    return { ...prompt, runEveries };

    async function runEveries() {
        for (let j of prompt.every) {
            const thing = await getPrompt(j.body, prompt.variables);
            if (!thing.body?.trim()?.length) { continue };
            prompt.variables.claude_response = await new Promise(r => {
                convo.sendMessage(thing.body, status({
                    attachments: thing.attachments,
                    done(a) {
                        r(a);
                    }
                }, { clear: true }))
            })
        }
    }
}

main();

function EXIT(status) {
    process.exit(status);
}