const axios = require('axios');
const fs = require('fs');
const readline = require('readline');
const { exec } = require('child_process');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { spawn } = require('child_process');

const argv = yargs(hideBin(process.argv))
  .option('p', { type: 'string', describe: 'The prompt to be used for completion' })
  .option('f', { type: 'string', describe: 'The prompt template file' })
  .option('filenames', { type: 'array', describe: 'Filenames to prepend to the prompt' })
  .option('i', { type: 'boolean', describe: 'Whether to pipe in the prompt from another command' })
  .option('c', { type: 'boolean', describe: 'Whether input/files are code and should be prepared as such' })
  .option('e', { type: 'boolean', describe: 'Whether the prompt result should be an executable command' })
  .option('m', { type: 'boolean', describe: 'Whether to modify the original file', default: 'false' })
  .option('model', { type: 'string', describe: 'The model to use for completion', default: 'gpt-4o' })
  .option('max_tokens', { type: 'number', describe: 'The maximum number of tokens to generate', default: 1000 })
  .option('temperature', { type: 'number', describe: 'The temperature to use for sampling', default: 0.7 })
  .option('top_p', { type: 'number', describe: 'The proportion of the mass to consider', default: 0.9 })
  .option('n', { type: 'number', describe: 'The number of completions to generate', default: 1 })
  .option('stream', { type: 'boolean', describe: 'Whether to stream completions', default: false })
  .option('logprobs', { type: 'number', describe: 'The log probabilities of the previous tokens', default: null })
  .option('stop', { type: 'string', describe: 'The token at which to stop generating', default: null })
  .option('debug', { type: 'boolean', describe: 'Whether to prepend the composed prompt to the output', default: false })
  .argv;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GPT_APPEND_PROMPT = process.env.GPT_APPEND_PROMPT || '';
let contents = '';
let originalFile = '';
let systemMessage = 'You are a helpful assistant.';

const readFiles = async (filenames) => {
  if (filenames.length === 1) {
    originalFile = filenames[0];
  }
  for (const filename of filenames) {
    contents += fs.readFileSync(filename, 'utf8');
  }
};

const readStdin = async () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  for await (const line of rl) {
    contents += line;
  }
};

const executePrompt = async (payload) => {
  if (argv.debug) {
    console.log(process.env);
    console.log(argv);
    console.log(payload);
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENAI_API_KEY}`
  };

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', payload, { headers });
    const responseData = response.data;
    const completions = responseData.choices.map(choice => choice.message.content);
    let content = completions[0];

    if (argv.c && content.startsWith('```')) {
      content = content.split('\n').slice(1, -1).join('\n');
    }

    return content.trim();
  } catch (error) {
    return error.response ? error.response.data : error.message;
  }
};

const main = async () => {
  if (argv.filenames) {
    await readFiles(argv.filenames);
  }

  if (argv.i) {
    await readStdin();
  }

  if (contents && argv.c) {
    systemMessage += ' Reply with the code ONLY and DO NOT provide any context or instructions.';
    contents = `\`\`\`\n${contents}\n\`\`\``;
  }
  if (argv.e) {
    systemMessage += ' Reply ONLY with the MacOS terminal command to be executed. Do NOT add any context or explanations.';
  }

  let prompt = argv.p || '';
  if (contents) {
    prompt = argv.p ? `${contents}\n\n${argv.p}` : contents;
    if (argv.c) {
      prompt += '\n\n```';
    }
  }
  if (GPT_APPEND_PROMPT) {
    prompt = `${prompt}\n\n${GPT_APPEND_PROMPT}`;
  }

  const messages = [
    { role: 'system', content: systemMessage },
    { role: 'user', content: prompt }
  ];

  const payload = {
    messages,
    model: argv.model,
    max_tokens: argv.max_tokens,
    temperature: argv.temperature,
    top_p: argv.top_p,
    n: argv.n,
    stop: argv.stop ? argv.stop.replace('\\n', '\n') : null
  };

  if (argv.m === 'true') {
    console.log(`Interactively modifying ${originalFile}...`);
  }

  const result = await executePrompt(payload);


  if (argv.m !== 'false') {
    // Open the modification in vim so the user can review and save it
    const originalFileEnding = originalFile.split('.').pop();
    const tempFile = `/tmp/${originalFileEnding ? `temp.${originalFileEnding}` : 'temp'}`;
    fs.writeFileSync(tempFile, result);
    console.log(`Opening ${tempFile} in vim...`);
    const vim = spawn('nvim', [tempFile], { stdio: 'inherit' });

    vim.on('exit', (code) => {
      if (code !== 0) {
        console.error(`Vim exited with code ${code}`);
      }
      // Do not modify if the file is empty
      if (!fs.readFileSync(tempFile, 'utf8')) {
        return;
      }
      // Save to original file
      fs.writeFileSync(originalFile, fs.readFileSync(tempFile, 'utf8'));
      console.log(`Saved to ${originalFile}`);
    });
  } else if (argv.e) {
    const escapedResult = result.replace(/'/g, "'\\''").replace(/```(.+)?/g, '').trim();
    exec(`echo '${escapedResult}' | pbcopy`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error copying to clipboard: ${error.message}`);
        return;
      }
      console.log(escapedResult);
      console.log('---');
      console.log('Copied to clipboard');
    });
  } else {
    console.log(result);
  }

};

main();

