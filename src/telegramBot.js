import { config } from './config.js';
import { searchPeople } from './agent.js';

const chatState = new Map();
let offset = 0;

const funnySearchStages = [
  'Reading the request like an over-caffeinated founder',
  'Searching LinkedIn-shaped haystacks',
  'Asking the diaspora group chat, spiritually',
  'Checking if their aunt knows your aunt',
  'Verifying company receipts, not vibes',
  'Looking for Armenian identity signals',
  'Separating real leads from LinkedIn confetti',
  'Drafting a non-cringe outreach angle',
];

if (!config.telegramBotToken) {
  console.error('TELEGRAM_BOT_TOKEN is not configured.');
  process.exit(1);
}

console.log('Find Your Armenian Telegram bot starting...');
await telegram('deleteWebhook', { drop_pending_updates: false });
const me = await telegram('getMe');
console.log(`Telegram bot running as @${me.result?.username || 'unknown'}`);

while (true) {
  try {
    const updates = await telegram('getUpdates', {
      offset,
      timeout: 45,
      allowed_updates: ['message', 'callback_query'],
    });

    for (const update of updates.result || []) {
      offset = Math.max(offset, update.update_id + 1);
      await handleUpdate(update);
    }
  } catch (error) {
    console.error('Telegram polling error:', error.message);
    await sleep(3000);
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  const message = update.message;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim();
  if (!chatId || !text) return;

  const state = getChatState(chatId);

  if (text === '/start' || text === '/help') {
    await sendMessage(chatId, helpText(state), settingsKeyboard(state));
    return;
  }

  if (text === '/agent' || text === 'Agent mode') {
    state.mode = 'agent';
    await sendMessage(chatId, 'Agent mode is on. Just type who you want to find.');
    return;
  }

  if (text === '/fast' || text === 'Fast mode') {
    state.mode = 'fast';
    await sendMessage(chatId, 'Fast mode is on. Just type a search.');
    return;
  }

  if (text === '/live' || text === 'Live refresh') {
    if (state.refresh) {
      await sendMessage(chatId, 'Live refresh is already on.');
      return;
    }
    state.refresh = true;
    await sendMessage(chatId, 'Live refresh is on. I will bypass cached Apify tool results.');
    return;
  }

  if (text === '/cache' || text === 'Cache-first') {
    if (!state.refresh) {
      await sendMessage(chatId, 'Cache-first is already on.');
      return;
    }
    state.refresh = false;
    await sendMessage(chatId, 'Cache-first is on.');
    return;
  }

  if (text === '/settings') {
    await sendMessage(chatId, settingsText(state), settingsKeyboard(state));
    return;
  }

  if (text === 'Help') {
    await sendMessage(chatId, helpText(state), settingsKeyboard(state));
    return;
  }

  if (text === '/examples' || text === 'Examples') {
    await sendMessage(chatId, examplesText());
    return;
  }

  const parsed = parseSearchText(text, state);
  const loading = await sendMessage(
    chatId,
    progressText(parsed, 0),
  );
  const progress = startProgressTicker(chatId, loading.result?.message_id, parsed);

  try {
    const result = await searchPeople({
      query: parsed.query,
      refresh: parsed.refresh,
      mode: parsed.mode,
      limit: parsed.limit,
    });

    await sendMessage(chatId, formatSearchResult(result, parsed), {
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
      ...resultKeyboard(result),
    });

    if (loading.result?.message_id) {
      progress.stop();
      await telegram('deleteMessage', {
        chat_id: chatId,
        message_id: loading.result.message_id,
      }).catch(() => {});
    }
  } catch (error) {
    progress.stop();
    await sendMessage(chatId, `Search failed: ${error.message}`, {
      reply_to_message_id: message.message_id,
    });
  }
}

function startProgressTicker(chatId, messageId, parsed) {
  if (!messageId) return { stop() {} };

  let index = 0;
  const timer = setInterval(() => {
    index = (index + 1) % funnySearchStages.length;
    telegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: progressText(parsed, index),
      disable_web_page_preview: true,
    }).catch(() => {});
  }, 3500);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

function progressText(parsed, index) {
  return [
    `${parsed.mode === 'agent' ? 'Agent' : 'Fast'} search ${parsed.refresh ? '(live)' : '(cache-first)'}`,
    '',
    funnySearchStages[index],
    '',
    parsed.query,
  ].join('\n');
}

async function handleCallback(callback) {
  const chatId = callback.message?.chat?.id;
  const data = callback.data || '';
  if (!chatId) return;

  const state = getChatState(chatId);
  if (data === 'mode:agent') {
    state.mode = 'agent';
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Agent mode on' });
    await editMessageReplyMarkup(chatId, callback.message.message_id, settingsKeyboard(state).reply_markup);
    return;
  }
  if (data === 'mode:fast') {
    state.mode = 'fast';
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Fast mode on' });
    await editMessageReplyMarkup(chatId, callback.message.message_id, settingsKeyboard(state).reply_markup);
    return;
  }
  if (data === 'refresh:live') {
    state.refresh = true;
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Live refresh on' });
    await editMessageReplyMarkup(chatId, callback.message.message_id, settingsKeyboard(state).reply_markup);
    return;
  }
  if (data === 'refresh:cache') {
    state.refresh = false;
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Cache-first on' });
    await editMessageReplyMarkup(chatId, callback.message.message_id, settingsKeyboard(state).reply_markup);
  }
}

function getChatState(chatId) {
  if (!chatState.has(chatId)) {
    chatState.set(chatId, {
      mode: config.telegramDefaultMode === 'fast' ? 'fast' : 'agent',
      refresh: false,
    });
  }
  return chatState.get(chatId);
}

function parseSearchText(text, state) {
  let query = text;
  let mode = state.mode;
  let refresh = state.refresh;

  if (/^\/agent\s+/i.test(query)) {
    mode = 'agent';
    query = query.replace(/^\/agent\s+/i, '');
  }
  if (/^\/fast\s+/i.test(query)) {
    mode = 'fast';
    query = query.replace(/^\/fast\s+/i, '');
  }
  if (/^live:/i.test(query)) {
    refresh = true;
    query = query.replace(/^live:\s*/i, '');
  }
  if (/^cache:/i.test(query)) {
    refresh = false;
    query = query.replace(/^cache:\s*/i, '');
  }

  return {
    query: query.trim(),
    mode,
    refresh,
    limit: limitFromText(query),
  };
}

function limitFromText(text) {
  const match = text.match(/\b(?:at least|top|find)\s+(\d{1,2})\b/i);
  const value = Number.parseInt(match?.[1] || '', 10);
  if (!Number.isFinite(value)) return config.telegramDefaultLimit;
  return Math.max(1, Math.min(10, value));
}

function formatSearchResult(result, parsed) {
  const people = result.results || [];
  const header = [
    `Mode: ${result.mode || parsed.mode}`,
    result.cached ? 'Query cache: hit' : 'Query cache: fresh',
    `Results: ${people.length}`,
  ];

  const trace = result.mode !== 'fast'
    ? [
        '',
        `Plan: ${(result.plan?.steps || []).map((step) => step.tool).join(' -> ') || 'n/a'}`,
        `Tools: ${(result.runs || []).map((run) => `${run.cached ? 'cached' : run.demo ? 'demo' : 'live'} ${run.actorId}`).join(', ') || 'none'}`,
      ]
    : [];

  const body = people.length
    ? people.slice(0, parsed.limit).map((person, index) => formatPerson(person, index + 1)).join('\n\n')
    : 'No verified candidates found. Try a broader company/location, or use live: before your query.';

  return trimTelegramMessage([...header, ...trace, '', body].join('\n'));
}

function formatPerson(person, index) {
  const lines = [
    `${index}. ${person.name}`,
    [person.company, person.location].filter(Boolean).join(' · '),
  ].filter(Boolean);

  if (person.headline) lines.push(person.headline);
  const evidence = (person.evidence || []).slice(0, 2).map((item) => `- ${item.text}`);
  if (evidence.length) lines.push(...evidence);
  if (person.outreachAngle) lines.push(`Outreach: ${person.outreachAngle}`);
  const source = person.sources?.find((item) => item.url)?.url;
  if (source) lines.push(`Source: ${source}`);
  return lines.join('\n');
}

function helpText(state) {
  return [
    'Find Your Armenian bot',
    '',
    'Just type a search. Armenian identity is assumed by default.',
    '',
    'Try:',
    'people at Google in Bay Area',
    'NVIDIA Santa Clara',
    'OpenAI product people',
    '',
    `Mode: ${state.mode === 'agent' ? 'Agent' : 'Fast'}`,
    `Data: ${state.refresh ? 'Live refresh' : 'Cache-first'}`,
    '',
    'Commands: /settings /agent /fast /live /cache /examples',
  ].join('\n');
}

function examplesText() {
  return [
    'Examples you can send:',
    '',
    'people at Google in Bay Area',
    'NVIDIA Santa Clara',
    'OpenAI product people',
    'AI founders in San Francisco',
    'someone in Google sales',
    'Anthropic research people',
    '',
    'Prefix with live: to force fresh Apify calls.',
  ].join('\n');
}

function settingsText(state) {
  return [
    'Settings',
    '',
    `Mode: ${state.mode === 'agent' ? 'Agent' : 'Fast'}`,
    `Data: ${state.refresh ? 'Live refresh' : 'Cache-first'}`,
    '',
    'Use the buttons below to change how I search.',
  ].join('\n');
}

function settingsKeyboard(state) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: state.mode === 'agent' ? '✓ Agent' : 'Agent', callback_data: 'mode:agent' },
          { text: state.mode === 'fast' ? '✓ Fast' : 'Fast', callback_data: 'mode:fast' },
        ],
        [
          { text: state.refresh ? '✓ Live refresh' : 'Live refresh', callback_data: 'refresh:live' },
          { text: !state.refresh ? '✓ Cache-first' : 'Cache-first', callback_data: 'refresh:cache' },
        ],
      ],
    },
  };
}

function resultKeyboard(result) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Agent', callback_data: 'mode:agent' },
          { text: 'Fast', callback_data: 'mode:fast' },
        ],
        [
          { text: 'Live refresh', callback_data: 'refresh:live' },
          { text: 'Cache-first', callback_data: 'refresh:cache' },
        ],
        ...(result.results || []).slice(0, 3).map((person) => {
          const source = person.sources?.find((item) => item.url)?.url;
          return source ? [{ text: `Open ${person.name}`.slice(0, 64), url: source }] : [];
        }).filter((row) => row.length),
      ],
    },
  };
}

async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(body.description || `Telegram ${method} failed`);
  }
  return body;
}

function sendMessage(chatId, text, options = {}) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text: trimTelegramMessage(text),
    disable_web_page_preview: true,
    ...options,
  });
}

function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  return telegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

function trimTelegramMessage(value) {
  const text = String(value || '').trim();
  return text.length > 3900 ? `${text.slice(0, 3900)}\n\n...trimmed` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
