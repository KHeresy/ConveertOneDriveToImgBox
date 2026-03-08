const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Helper function to wait for any file to appear in the directory
async function waitAnyFile(downloadPath, timeoutMs = 30000) {
    const interval = 500;
    const maxTry = timeoutMs / interval;
    for (let i = 0; i < maxTry; i++) {
        if (!fs.existsSync(downloadPath)) {
            await new Promise(resolve => setTimeout(resolve, interval));
            continue;
        }
        const files = fs.readdirSync(downloadPath).filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
        if (files.length > 0) {
            // Sort by mtime to get the most recent one if there are multiple (though there should only be one)
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

    // Initialize the Puppeteer browser instance
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

    // Handle interactive login
    async login(options = {}) {
        const { userDataDir } = options;
        if (!userDataDir) {
            throw new Error('User data directory is required for login.');
        }

        // Initialize browser in headful mode
        await this.initialize({ headless: false, userDataDir });

        const page = await this.browser.newPage();
        console.log('🚀 Navigating to OneDrive login page...');
        await page.goto('https://onedrive.live.com/', { waitUntil: 'networkidle2' });

        console.log('✅ Browser opened. Please log in to your OneDrive account.');
        console.log('🔒 The script will terminate automatically when you close the browser window.');

        // Wait for the browser to be closed by the user
        await new Promise(resolve => this.browser.on('disconnected', resolve));
        this.browser = null; // Nullify the browser instance
        console.log('Browser closed by user. Login process complete.');
    }

    // Download a single file from a URL
    async download(url, downloadPath = './downloads', options = {}) {
        if (!this.browser) {
            throw new Error('Browser not initialized. Please call initialize() first.');
        }

        const {
            maxRetries = 1,
            timeoutMs = 30000,
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
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

                const finalUrl = page.url();
                if (finalUrl !== url) {
                    console.log(`📍 Final URL: ${finalUrl}`);
                }

                // Wait for potential dynamic content
                await new Promise(resolve => setTimeout(resolve, 3000));

                const selectors = [
                    'button[data-automationid="download"]',
                    'a[data-automationid="download"]',
                    'button[name="Download"]',
                    'button[title="Download"]',
                    'button[aria-label="Download"]',
                    '#__photo-view-download'
                ];

                let downloadButton = null;
                for (const selector of selectors) {
                    try {
                        downloadButton = await page.waitForSelector(selector, { timeout: 5000 });
                        if (downloadButton) {
                            console.log(`🎯 Found download button with selector: ${selector}`);
                            break;
                        }
                    } catch (e) {}
                }

                if (!downloadButton) {
                    // Try by text (English and Chinese)
                    const buttons = await page.$$('button, a');
                    for (const btn of buttons) {
                        const text = await page.evaluate(el => el.innerText, btn);
                        if (text && (text.includes('Download') || text.includes('下載'))) {
                            downloadButton = btn;
                            console.log(`🎯 Found download button by text: "${text.trim()}"`);
                            break;
                        }
                    }
                }

                if (!downloadButton) {
                    // Check if we are on a login page
                    const isLogin = await page.evaluate(() => document.body.innerText.includes('Sign in'));
                    if (isLogin) {
                        throw new Error('Authentication required. Please use --login mode first.');
                    }
                    throw new Error('Could not find download button.');
                }

                await downloadButton.click();
                console.log('🖱️ Download button clicked.');

                const filePath = await waitAnyFile(downloadPath, timeoutMs);
                if (!filePath) {
                    throw new Error(`Timeout waiting for download in: ${downloadPath}`);
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
                console.log(`✅ Successfully downloaded: ${path.basename(filePath)}`);
                return filePath;

            } catch (err) {
                if (attempt === maxRetries) {
                    throw err;
                }
                console.warn(`⚠️ Attempt ${attempt + 1} failed: ${err.message}. Retrying...`);
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            } finally {
                if (page) await page.close();
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
