// content/cloudflare-mail.js — Generic polling for Cloudflare temp mail pages (steps 4, 7)
// Injected dynamically on the configured Cloudflare mailbox page

var CLOUDFLARE_MAIL_PREFIX = '[MultiPage:cloudflare-mail]';
var isTopFrame = window === window.top;
var SEEN_MAIL_IDS_KEY = 'seenCloudflareMailIds';

console.log(CLOUDFLARE_MAIL_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

if (!isTopFrame) {
  console.log(CLOUDFLARE_MAIL_PREFIX, 'Skipping child frame');
} else {

var seenMailIds = new Set();

async function loadSeenMailIds() {
  try {
    const data = await chrome.storage.session.get(SEEN_MAIL_IDS_KEY);
    if (Array.isArray(data[SEEN_MAIL_IDS_KEY])) {
      seenMailIds = new Set(data[SEEN_MAIL_IDS_KEY]);
      console.log(CLOUDFLARE_MAIL_PREFIX, `Loaded ${seenMailIds.size} previously seen mail ids`);
    }
  } catch (err) {
    console.warn(CLOUDFLARE_MAIL_PREFIX, 'Session storage unavailable, using in-memory seen mail ids:', err?.message || err);
  }
}

async function persistSeenMailIds() {
  try {
    await chrome.storage.session.set({ [SEEN_MAIL_IDS_KEY]: [...seenMailIds] });
  } catch (err) {
    console.warn(CLOUDFLARE_MAIL_PREFIX, 'Could not persist seen mail ids, continuing in-memory only:', err?.message || err);
  }
}

loadSeenMailIds();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    resetStopState();
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      if (isStopError(err)) {
        log(`步骤 ${message.step}：已被用户停止。`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      log(`步骤 ${message.step}：邮箱轮询失败：${err.message}`, 'warn');
      sendResponse({ error: err.message });
    });
    return true;
  }
});

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function extractVerificationCode(text) {
  const source = normalizeText(text);

  const matchCn = source.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEn = source.match(/(?:verification|login|one[-\s]*time|passcode|code)[^0-9]{0,24}(\d{6})/i);
  if (matchEn) return matchEn[1];

  const match6 = source.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}

function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function extractRenderedMailId(text) {
  const normalized = normalizeText(text);
  if (!normalized) return '';

  const match = normalized.match(/\bID:\s*([A-Za-z0-9_-]{6,})\b/i);
  return match ? match[1] : '';
}

function collectSameOriginFrameText() {
  const texts = [];
  for (const frame of document.querySelectorAll('iframe')) {
    try {
      const frameText = normalizeText(frame.contentDocument?.body?.innerText || frame.contentDocument?.body?.textContent || '');
      if (frameText) {
        texts.push(frameText);
      }
    } catch {
      // Cross-origin iframe, ignore.
    }
  }
  return texts.join('\n');
}

function getPageText() {
  return [document.body?.innerText || document.body?.textContent || '', collectSameOriginFrameText()]
    .map(normalizeText)
    .filter(Boolean)
    .join('\n');
}

function matchMailText(text, senderFilters, subjectFilters, targetEmail) {
  const normalized = normalizeLower(text);
  const targetLocal = normalizeLower((targetEmail || '').split('@')[0]);
  const filterWords = [...senderFilters, ...subjectFilters].map(item => normalizeLower(item)).filter(Boolean);
  const code = extractVerificationCode(text);
  const hasFilterWord = filterWords.some(word => normalized.includes(word));
  const hasKeyword = /openai|chatgpt|verification|verify|confirm|login|code|验证码|代码/.test(normalized);
  const hasTargetLocal = Boolean(targetLocal) && normalized.includes(targetLocal);

  let score = 0;
  if (code) score += 4;
  if (hasFilterWord) score += 3;
  if (hasKeyword) score += 2;
  if (hasTargetLocal) score += 3;
  if (code && (hasFilterWord || hasKeyword || hasTargetLocal)) score += 2;

  return {
    code,
    matched: score > 0 && (Boolean(code) || hasFilterWord || hasKeyword || hasTargetLocal),
    score,
    hasTargetLocal,
  };
}

function getMailCandidateId(el, index) {
  const renderedId = extractRenderedMailId(el.innerText || el.textContent || '');
  if (renderedId) return `rendered:${renderedId}`;

  const explicitId = el.getAttribute('data-id')
    || el.getAttribute('data-message-id')
    || el.getAttribute('data-mail-id')
    || el.getAttribute('data-email-id')
    || el.id
    || '';
  if (explicitId) return explicitId;

  const href = el.getAttribute('href') || '';
  if (href) return `href:${href}`;

  return `cf:${index}:${hashText(normalizeText(el.innerText || el.textContent || '').slice(0, 800))}`;
}

function collectMailCandidates(payload) {
  const selectors = [
    '.mail-item',
    '.n-card',
    '.n-card-header',
    '.n-card__content',
    '[data-message-id]',
    '[data-mail-id]',
    '[data-email-id]',
    '[data-id]',
    '.message-item',
    '.message-row',
    '.message',
    '.mail-item',
    '.mail-row',
    '.mail-card',
    '.email-item',
    '.email-row',
    'article',
    'tr',
    'li',
    '[role="row"]',
    '[role="article"]',
    'a',
  ];
  const visited = new Set();
  const candidates = [];

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector));
    for (const el of elements) {
      if (visited.has(el) || !isVisible(el)) continue;
      visited.add(el);

      const text = normalizeText(el.innerText || el.textContent || '');
      if (text.length < 12) continue;
      const renderedId = extractRenderedMailId(text);

      const match = matchMailText(text, payload.senderFilters || [], payload.subjectFilters || [], payload.targetEmail || '');
      if (!match.matched) continue;

      // The target app visibly renders "ID: <mail-id>" for each list item.
      // Prefer those rows and skip generic containers/buttons without a mail id.
      if (!renderedId && (selector === '.mail-item' || selector === '.n-card' || selector === '.n-card-header' || selector === '.n-card__content')) {
        continue;
      }

      candidates.push({
        element: el,
        text,
        score: match.score,
        code: match.code,
        mailId: renderedId ? `rendered:${renderedId}` : getMailCandidateId(el, candidates.length),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function getCurrentCandidateIds(payload) {
  return new Set(collectMailCandidates(payload).map((candidate) => candidate.mailId));
}

function getClickTarget(el) {
  return el.closest('button, a, [role="button"], [role="link"], [tabindex]') || el;
}

async function openMailCandidate(candidate) {
  const target = getClickTarget(candidate.element);
  if (!target || target === document.body || target === document.documentElement) {
    return;
  }

  simulateClick(target);
  await sleep(900);
}

async function refreshMailbox() {
  const actions = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'))
    .filter(isVisible);

  const refreshAction = actions.find((el) => /刷新|更新|收信|reload|refresh|check|sync/i.test(normalizeText(el.textContent || el.innerText || '')));
  if (!refreshAction) {
    return;
  }

  simulateClick(refreshAction);
  await sleep(3600);
}

function buildBodyFallbackCandidate(payload) {
  const text = getPageText();
  if (!text) return null;

  const match = matchMailText(text, payload.senderFilters || [], payload.subjectFilters || [], payload.targetEmail || '');
  if (!match.matched) return null;

  return {
    element: document.body,
    text,
    score: match.score,
    code: match.code,
    mailId: `body:${hashText(text.slice(0, 2000))}`,
  };
}

async function findVerificationCode(step, payload, excludedCodeSet, options = {}) {
  const {
    existingMailIds = new Set(),
    useFallback = false,
  } = options;
  const allCandidates = collectMailCandidates(payload);
  const candidates = allCandidates.filter((candidate) => {
    if (seenMailIds.has(candidate.mailId)) return false;
    if (useFallback) return true;
    return !existingMailIds.has(candidate.mailId);
  });

  // Only fall back to scanning the whole page when there are no matching list
  // candidates at all. Otherwise the page body often still contains the
  // previously opened mail content and can cause old-code false positives.
  if (!allCandidates.length && useFallback) {
    const bodyFallback = buildBodyFallbackCandidate(payload);
    if (bodyFallback && !seenMailIds.has(bodyFallback.mailId)) {
      candidates.push(bodyFallback);
    }
  }

  for (const candidate of candidates) {
    await openMailCandidate(candidate);

    const expandedText = normalizeText([
      candidate.text,
      getPageText(),
    ].filter(Boolean).join('\n'));

    const code = extractVerificationCode(expandedText) || candidate.code;
    if (!code) continue;
    if (excludedCodeSet.has(code)) {
      log(`步骤 ${step}：跳过排除的验证码：${code}`, 'info');
      seenMailIds.add(candidate.mailId);
      continue;
    }

    const finalMatch = matchMailText(expandedText, payload.senderFilters || [], payload.subjectFilters || [], payload.targetEmail || '');
    if (!finalMatch.matched) continue;

    seenMailIds.add(candidate.mailId);
    await persistSeenMailIds();

    log(
      `步骤 ${step}：已找到验证码：${code}（来源：Cloudflare 临时邮箱，候选：${candidate.mailId.slice(0, 36)}）`,
      'ok'
    );

    return {
      ok: true,
      code,
      emailTimestamp: Date.now(),
      mailId: candidate.mailId,
    };
  }

  return null;
}

async function handlePollEmail(step, payload) {
  const {
    maxAttempts = 20,
    intervalMs = 3000,
    excludeCodes = [],
  } = payload || {};
  const excludedCodeSet = new Set(excludeCodes.filter(Boolean));

  await waitForElement('body', 15000);
  log(`步骤 ${step}：开始轮询 Cloudflare 临时邮箱页面（最多 ${maxAttempts} 次）`);
  const existingMailIds = getCurrentCandidateIds(payload);
  log(`步骤 ${step}：已记录当前 ${existingMailIds.size} 条旧邮件快照`);
  const FALLBACK_AFTER = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`步骤 ${step}：正在轮询 Cloudflare 临时邮箱，第 ${attempt}/${maxAttempts} 次`);

    if (attempt > 1) {
      await refreshMailbox();
    }

    const useFallback = attempt > FALLBACK_AFTER;
    const result = await findVerificationCode(step, payload, excludedCodeSet, {
      existingMailIds,
      useFallback,
    });
    if (result) {
      return result;
    }

    if (attempt === FALLBACK_AFTER + 1) {
      log(`步骤 ${step}：连续 ${FALLBACK_AFTER} 次未发现新邮件，开始回退到旧邮件匹配`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `${(maxAttempts * intervalMs / 1000).toFixed(0)} 秒后仍未在 Cloudflare 临时邮箱中找到新的匹配邮件。` +
    '请手动检查邮箱页面。'
  );
}

} // end of isTopFrame else block
