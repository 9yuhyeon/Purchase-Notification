const { chromium } = require('playwright');
const fs = require('fs');
const https = require('https');

const ACCOUNTS = JSON.parse(process.env.ACCOUNTS);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SEEN_FILE = 'seen_orders.json';

const STATUSES = [
  '결제완료', '결제대기', '전달준비', '상품전달완료',
  '취소요청', '거래보류', 'PIN전달완료', '판매취소',
];

async function main() {
  const seen = fs.existsSync(SEEN_FILE)
    ? JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))
    : {};

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    for (const account of ACCOUNTS) {
      await processAccount(browser, account, seen);
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
  console.log('완료');
}

async function processAccount(browser, account, seen) {
  const label = account.label || account.id;
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  try {
    // 로그인 페이지 이동
    await page.goto('https://www.ticketbay.co.kr/member/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // 비밀번호 필드가 보일 때까지 대기 (폼 로드 확인)
    await page.waitForSelector('input[type="password"]', { state: 'visible', timeout: 15000 });

    // ID 입력 — 숨김 필드 제외하고 순서대로 시도
    const idSelectors = [
      'input[name="memberId"]',
      'input[name="userId"]',
      'input[name="loginId"]',
      'input[name="id"]',
      'input[type="email"]',
      'input[placeholder*="이메일"]',
      'input[placeholder*="아이디"]',
    ];

    let idFilled = false;
    for (const sel of idSelectors) {
      try {
        const el = page.locator(sel).first();
        await el.waitFor({ state: 'visible', timeout: 3000 });
        await el.fill(account.id);
        idFilled = true;
        console.log(`ID 입력 성공 (selector: ${sel})`);
        break;
      } catch {}
    }

    if (!idFilled) throw new Error('ID 입력 필드를 찾지 못했습니다');

    // PW 입력 후 Enter로 제출
    await page.fill('input[type="password"]', account.pw);
    await page.locator('input[type="password"]').press('Enter');

    // 로그인 완료 대기
    await page.waitForURL(url => !url.includes('/member/login'), { timeout: 20000 });

    console.log(`로그인 성공: ${label}`);
  } catch (e) {
    console.error(`로그인 실패: ${label} — ${e.message}`);
    await sendTelegram(`❌ TicketBay 로그인 실패\n계정: ${label}`);
    await context.close();
    return;
  }

  try {
    // 판매이력 1페이지 조회
    await page.goto('https://www.ticketbay.co.kr/mypage/sell/history/1', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const html = await page.content();
    const orders = parseOrders(html);
    const completed = orders.filter(o => o.status === '결제완료');

    console.log(`${label}: 결제완료 ${completed.length}건`);

    for (const order of completed) {
      const key = `${account.id}:${order.orderNo}`;
      if (!seen[key]) {
        seen[key] = new Date().toISOString();
        await sendTelegram(formatMessage(label, order));
      }
    }
  } catch (e) {
    console.error(`조회 실패: ${label} — ${e.message}`);
  } finally {
    await context.close();
  }
}

// ─────────────────────────────────────────
// HTML 파싱
// ─────────────────────────────────────────
function parseOrders(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

  const parts = text.split(/(C[MP][A-Z0-9]{16,20})/);
  const orders = [];

  for (let i = 1; i < parts.length; i += 2) {
    const orderNo = parts[i];
    const chunk = parts[i + 1] || '';

    let status = null;
    let statusIndex = Infinity;
    for (const s of STATUSES) {
      const idx = chunk.indexOf(s);
      if (idx !== -1 && idx < statusIndex) {
        statusIndex = idx;
        status = s;
      }
    }
    if (!status) continue;

    const dateMatch = chunk.match(/(\d{4}\.\d{2}\.\d{2})/);
    const orderDate = dateMatch?.[1] || '';

    const gameDateMatch = chunk.match(/경기 일시\s*(\d{4}\.\d{2}\.\d{2}\s*\d{2}:\d{2})/);
    const gameDate = gameDateMatch?.[1]?.replace(/\s+/, ' ') || '';

    const priceChunk = chunk.slice(0, statusIndex);
    const priceMatches = [...priceChunk.matchAll(/([\d,]+)원/g)];
    const totalPrice = priceMatches.length > 0
      ? priceMatches[priceMatches.length - 1][1] + '원'
      : '';

    orders.push({ orderNo, status, orderDate, gameDate, totalPrice });
  }

  return orders;
}

// ─────────────────────────────────────────
// 텔레그램 알림
// ─────────────────────────────────────────
function formatMessage(label, order) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const lines = [
    '🎫 TicketBay 결제완료 알림',
    '',
    `📋 주문번호: ${order.orderNo}`,
    `👤 계정: ${label}`,
    `📅 주문일: ${order.orderDate}`,
  ];
  if (order.gameDate) lines.push(`🏟️  경기일시: ${order.gameDate}`);
  if (order.totalPrice) lines.push(`💰 결제금액: ${order.totalPrice}`);
  lines.push('', `⏰ 감지시각: ${now}`);
  return lines.join('\n');
}

function sendTelegram(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', (e) => { console.error('Telegram 오류:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

main().catch(console.error);
