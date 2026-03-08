const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Helper function to wait for any file to appear in the directory
async function waitAnyFile(downloadPath, timeoutMs = 60000) {
    const interval = 1000;
    const maxTry = timeoutMs / interval;
    for (let i = 0; i < maxTry; i++) {
        if (!fs.existsSync(downloadPath)) {
            await new Promise(resolve => setTimeout(resolve, interval));
            continue;
        }
        const files = fs.readdirSync(downloadPath).filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
        if (files.length > 0) {
            const sortedFiles = files.map(f => ({
                name: f,
                time: fs.statSync(path.join(downloadPath, f)).mtime.getTime()
            })).sort((a, b) => b.time - a.time);
            return path.join(downloadPath, sortedFiles[0].name);
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    return null;
}

class OneDrive {
    constructor() {
        this.browser = null;
    }

    async initialize(options = {}) {
        const { headless = true, userDataDir = null } = options;
        const launchOptions = {
            headless,
            defaultViewport: { width: 1920, height: 1080 },
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        };
        if (userDataDir) {
            launchOptions.userDataDir = userDataDir;
        }
        this.browser = await puppeteer.launch(launchOptions);
    }

    async login(options = {}) {
        const { userDataDir } = options;
        if (!userDataDir) throw new Error('User data directory is required for login.');
        await this.initialize({ headless: false, userDataDir });
        const page = await this.browser.newPage();
        console.log('🚀 Navigating to OneDrive login page...');
        await page.goto('https://onedrive.live.com/', { waitUntil: 'networkidle2' });
        console.log('✅ Browser opened. Please log in. Script will end when browser is closed.');
        await new Promise(resolve => this.browser.on('disconnected', resolve));
        this.browser = null;
    }

    async download(url, downloadPath = './downloads', options = {}) {
        if (!this.browser) throw new Error('Browser not initialized.');

        // 如果是 skydrive 網址，將其替換為 onedrive 並執行標準下載
        if (url.includes('skydrive.live.com')) {
            console.log(`🌐 偵測到舊式 SkyDrive 網址，已標準化為 OneDrive 網址。`);
            url = url.replace('skydrive.live.com', 'onedrive.live.com');
        }

        if (url.includes('photos.live.com')) {
            console.log(`📜 偵測到舊式 Windows Live Photos 網址，啟動救援模式...`);
            return this.downloadFromOldUrl(url, downloadPath, options);
        }

        const { maxRetries = 1, timeoutMs = 60000, retryDelayMs = 2000 } = options;
        if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            let page;
            try {
                page = await this.browser.newPage();
                const client = await page.target().createCDPSession();
                await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath });

                console.log(`🚀 Attempting standard download (try ${attempt + 1}): ${url}`);
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                await new Promise(resolve => setTimeout(resolve, 3000));

                const downloadBtn = await this.findDownloadButton(page);
                if (!downloadBtn) throw new Error('Could not find download button.');

                await downloadBtn.click();
                console.log('🖱️ Download button clicked.');

                const filePath = await waitAnyFile(downloadPath, timeoutMs);
                if (!filePath) throw new Error('Download timeout.');

                return filePath;
            } catch (err) {
                if (attempt === maxRetries) throw err;
                console.warn(`⚠️ Attempt ${attempt + 1} failed: ${err.message}. Retrying...`);
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            } finally {
                if (page) await page.close();
            }
        }
    }

    async downloadFromOldUrl(url, downloadPath, options) {
        const { timeoutMs = 60000 } = options;
        const cidMatch = url.match(/cid-([a-z0-9]+)/i);
        const cid = cidMatch ? cidMatch[1].toUpperCase() : null;
        if (!cid) throw new Error('無法從網址提取 CID');

        const urlObj = new URL(url);
        const decodedPath = decodeURIComponent(urlObj.pathname.replace('/self.aspx/', ''));
        const pathParts = decodedPath.split('/').filter(p => p);
        const fileName = pathParts.pop();
        const folderName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : null;

        console.log(`🔍 解析資訊: CID=${cid}, 檔案=${fileName}, 資料夾關鍵字=${folderName}`);

        const page = await this.browser.newPage();
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath });

        try {
            await page.goto(`https://onedrive.live.com/?cid=${cid}`, { waitUntil: 'networkidle2', timeout: 60000 });

            const searchInputSelector = 'input[data-automationid="SearchBox"], input[placeholder*="搜尋"], input[placeholder*="Search"]';
            const searchInput = await page.waitForSelector(searchInputSelector, { timeout: 15000 });
            await searchInput.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            await searchInput.type(fileName);
            await page.keyboard.press('Enter');

            console.log(`⏳ 正在搜尋 ${fileName}...`);
            let found = false;
            const baseFileName = path.basename(fileName, path.extname(fileName));
            
            for (let retry = 0; retry < 3; retry++) {
                await new Promise(resolve => setTimeout(resolve, 5000));
                const targetInfo = await page.evaluate((fname, bname, folder) => {
                    const rows = Array.from(document.querySelectorAll('[role="row"], .ms-DetailsRow, [data-automationid="DetailsRow"]'));
                    for (const row of rows) {
                        const text = row.innerText || '';
                        const hasFileName = text.includes(fname) || text.includes(bname);
                        if (hasFileName) {
                            const folderKeywords = folder ? folder.split(/[^\w\u4e00-\u9fa5]/).filter(s => s.length > 2) : [];
                            const matchesFolder = !folder || folderKeywords.some(k => text.includes(k)) || text.includes(folder);
                            if (matchesFolder) {
                                const checkbox = row.querySelector('[role="checkbox"], .ms-Check');
                                if (checkbox) checkbox.click(); else row.click();
                                return { success: true, text: text.substring(0, 100) };
                            }
                        }
                    }
                    return { success: false };
                }, fileName, baseFileName, folderName);

                if (targetInfo.success) {
                    console.log(`🎯 找到匹配項: ${targetInfo.text}...`);
                    found = true;
                    break;
                }
            }

            if (!found) throw new Error(`在搜尋結果中找不到檔案: ${fileName}`);

            console.log('🎯 已選取目標檔案，準備下載...');
            await new Promise(resolve => setTimeout(resolve, 3000));

            const downloadBtn = await this.findDownloadButton(page);
            if (!downloadBtn) throw new Error('找不到下載按鈕');

            await downloadBtn.click();
            console.log('🖱️ 已點擊下載按鈕');

            const filePath = await waitAnyFile(downloadPath, timeoutMs);
            if (!filePath) throw new Error('下載超時');

            return filePath;
        } finally {
            await page.close();
        }
    }

    async findDownloadButton(page) {
        const selectors = [
            'button[data-automationid="download"]',
            'button[data-automationid="downloadCommand"]',
            'button[name="Download"]',
            'button[name="下載"]',
            'button[aria-label*="Download"]',
            'button[aria-label*="下載"]',
            '#__photo-view-download'
        ];

        for (const sel of selectors) {
            try {
                const btn = await page.$(sel);
                if (btn) {
                    const isVisible = await page.evaluate(el => {
                        const rect = el.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
                    }, btn);
                    if (isVisible) return btn;
                }
            } catch (e) {}
        }

        // Try "More" menu
        const moreBtn = await page.$('button[data-automationid="more"], button[aria-label*="更多"], button[aria-label*="More"]');
        if (moreBtn) {
            await moreBtn.click();
            await new Promise(resolve => setTimeout(resolve, 1500));
            for (const sel of selectors) {
                const btn = await page.$(sel);
                if (btn) return btn;
            }
        }

        // Search by text
        const buttons = await page.$$('button');
        for (const btn of buttons) {
            const text = await page.evaluate(el => el.innerText, btn);
            if (text && (text.includes('Download') || text.includes('下載'))) return btn;
        }

        return null;
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            console.log('Browser closed.');
        }
    }
}

module.exports = OneDrive;
