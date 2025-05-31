const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// 等待檔案出現的函式
async function waitFileExists(filePath, timeoutMs = 15000) {
    const interval = 500;
    const maxTry = timeoutMs / interval;
    for (let i = 0; i < maxTry; i++) {
        if (fs.existsSync(filePath)) return true;
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    return false;
}

// 實際執行一次下載的函式
async function runDownloadSession(url, downloadPath, timeoutMs) {
    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: { width: 1920, height: 1080 }
    });

    const page = await browser.newPage();
    const client = await page.target().createCDPSession();

    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath
    });

    console.log(`🚀 嘗試下載：${url}`);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    await new Promise(resolve => setTimeout(resolve, 3000));

    const filename = await page.$eval('button[role="text"]', btn => btn.getAttribute('title'));
    await page.click('button[data-automationid="download"]');

    const filePath = path.join(downloadPath, filename);
    const downloaded = await waitFileExists(filePath, timeoutMs);

    await browser.close();

    if (!downloaded) {
        console.log(`❌ 等待逾時，未找到檔案：${filePath}`);
        throw new Error(`❌ 等待逾時，未找到檔案：${filePath}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    return filePath;
}

// 對外的主要函式
async function downloadFromOneDrive(url, downloadPath = './downloads', options = {}) {
    const {
        maxRetries = 1,
        timeoutMs = 15000,
        retryDelayMs = 2000
    } = options;

    if (!fs.existsSync(downloadPath)) {
        fs.mkdirSync(downloadPath, { recursive: true });
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await runDownloadSession(url, downloadPath, timeoutMs);
        } catch (err) {
            const isLast = attempt === maxRetries;
            if (isLast) {
                throw new Error(`❌ 全部重試失敗：${url}\n錯誤：${err.message}`);
            } else {
                console.warn(`⚠️ 第 ${attempt + 1} 次嘗試失敗，準備重試...`);
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
        }
    }
}

module.exports = { downloadFromOneDrive };
