const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Helper function to wait for a file to exist
async function waitFileExists(filePath, timeoutMs = 15000) {
    const interval = 500;
    const maxTry = timeoutMs / interval;
    for (let i = 0; i < maxTry; i++) {
        if (fs.existsSync(filePath)) return true;
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    return false;
}

class OneDrive {
    constructor() {
        this.browser = null;
    }

    // Initialize the Puppeteer browser instance
    async initialize(options = {}) {
        const { headless = true, userDataDir = null } = options;
        this.browser = await puppeteer.launch({
            headless,
            defaultViewport: { width: 1920, height: 1080 },
            userDataDir: userDataDir
        });
    }

    // Download a single file from a URL
    async download(url, downloadPath = './downloads', options = {}) {
        if (!this.browser) {
            throw new Error('Browser not initialized. Please call initialize() first.');
        }

        const {
            maxRetries = 1,
            timeoutMs = 15000,
            retryDelayMs = 2000
        } = options;

        if (!fs.existsSync(downloadPath)) {
            fs.mkdirSync(downloadPath, { recursive: true });
        }

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            let page;
            try {
                page = await this.browser.newPage();
                const client = await page.target().createCDPSession();

                await client.send('Page.setDownloadBehavior', {
                    behavior: 'allow',
                    downloadPath
                });

                console.log(`🚀 Attempting to download (try ${attempt + 1}): ${url}`);
                await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
                await new Promise(resolve => setTimeout(resolve, 3000));

                let filename = "";
                if (url.startsWith('https://1drv.ms/u/s!')) {
                    filename = await page.$eval('button[role="text"]', btn => btn.getAttribute('title'));
                    await page.click('button[data-automationid="download"]');
                } else if (url.startsWith('https://1drv.ms/i/')) {
                    const title = await page.title();
                    filename = title.split(" - ")[0];
                    const button = await page.$('#__photo-view-download');
                    await button.click();
                }

                if (!filename) {
                    throw new Error('Could not determine filename.');
                }

                const filePath = path.join(downloadPath, filename);
                const downloaded = await waitFileExists(filePath, timeoutMs);

                if (!downloaded) {
                    throw new Error(`Timeout waiting for file: ${filePath}`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 500)); // Short delay to ensure file handle is released
                console.log(`✅ Successfully downloaded: ${filePath}`);
                return filePath;

            } catch (err) {
                const isLast = attempt === maxRetries;
                if (isLast) {
                    throw new Error(`❌ All retries failed for ${url}. Last error: ${err.message}`);
                } else {
                    console.warn(`⚠️ Download attempt ${attempt + 1} failed. Retrying in ${retryDelayMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                }
            } finally {
                if (page) {
                    await page.close();
                }
            }
        }
    }

    // Close the Puppeteer browser
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            console.log('Browser closed.');
        }
    }
}

module.exports = OneDrive;
