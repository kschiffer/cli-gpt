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
  .option('l', { type: 'boolean', describe: 'Whether to use the local API', default: 'false' })
  .option('model', { type: 'string', describe: 'The model to use for completion', default: 'auto' })
  .option('max_tokens', { type: 'number', describe: 'The maximum number of tokens to generate', default: 64_000 })
  .option('temperature', { type: 'number', describe: 'The temperature to use for sampling', default: 0.7 })
  .option('top_p', { type: 'number', describe: 'The proportion of the mass to consider', default: 0.9 })
  .option('stop', { type: 'string', describe: 'The token at which to stop generating', default: null })
  .option('debug', { type: 'boolean', describe: 'Whether to prepend the composed prompt to the output', default: false })
  .argv;

const LOCAL_API_HOST = process.env.LOCAL_API_HOST || 'http://localhost:1234/v1';
const ANTHROPIC_API_HOST = process.env.ANTHROPIC_API_HOST || 'https://api.anthropic.com/v1';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PROMPT_APPEND = process.env.PROMPT_APPEND || '';
let contents = '';
let originalFile = '';
let systemMessage = 'You are a helpful assistant.';
const HOST = argv.l == true ? LOCAL_API_HOST : ANTHROPIC_API_HOST;

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
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  };

  try {
    const response = await axios.post(`${HOST}/messages`, payload, { headers });
    const responseData = response.data;
    let content = responseData.content.reduce((acc, item) => {
      if (item.type === 'text') {
        return acc + item.text;
      }
      return acc;
    }, '');

    if (argv.c && content.startsWith('```')) {
      content = content.split('\n').slice(1, -1).join('\n');
    }

    return content.trim();
  } catch (error) {
    console.error(error);
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

  if (argv.c) {
    systemMessage += ' Reply with the code ONLY and DO NOT provide any context, explanations or instructions and keep the same formatting and coding style.';
    if (contents) {
      contents = `\`\`\`\n${contents}\n\`\`\``;
    }
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
  if (PROMPT_APPEND) {
    prompt = `${prompt}\n\n${PROMPT_APPEND}`;
  }

  const messages = [
    { role: 'user', content: prompt }
  ];

  let model = argv.model;
  if (model === 'auto') {
    if (argv.l == true) {
      try {
        // Fetch models for local API
        const modelsResponse = await axios.get(`${HOST}/models`, {
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          }
        });
        const models = modelsResponse.data.data.map(model => model.id);
        model = models[0] || 'claude-3-sonnet-20240229';
      } catch (error) {
        console.warn('Could not fetch models, using default model');
        model = 'claude-3-sonnet-20240229';
      }
    } else {
      model = 'claude-3-7-sonnet-20250219'; // Using the latest Claude model as default
    }
  }

  const payload = {
    model,
    messages,
    system: systemMessage,
    max_tokens: argv.max_tokens,
    temperature: argv.temperature,
    top_p: argv.top_p,
    stop_sequences: argv.stop ? [argv.stop.replace('\\n', '\n')] : []
  };

  if (argv.m == true) {
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
