const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { imgbox } = require('imgbox-js');
const { downloadFromOneDrive } = require('./onedrive_dl');

const inputHtmlPath = 'wordpress.html';
const outputHtmlPath = 'output.html';
const downloadDir = 'z:\\wnacg\\images\\';
const imgboxAuthCookie = process.env.IMGBOX_COOKIE;

if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function uploadToImgbox(filePath) {
    const options = {
        auth_cookie: imgboxAuthCookie,
        content_type: 'safe',
        thumbnail_size: '800r',
        comments_enabled: false,
        logger: false
    };
    const res = await imgbox(filePath, options);
    return res.data[0].thumbnail_url;
}

(async () => {
    const html = fs.readFileSync(inputHtmlPath, 'utf-8');
    const $ = cheerio.load(html);

    const tasks = [];

    $('a').each((_, el) => {
        const href = $(el).attr('href');
        const img = $(el).find('img');
        if (href && href.startsWith('https://1drv.ms/u/s!') && img.length > 0) {
            tasks.push({ href, imgTag: $(img) });
        }
    });

    console.log(`共找到 ${tasks.length} 筆 OneDrive 圖片`);

    for (const [i, { href, imgTag }] of tasks.entries()) {
        console.log(`\n🔄 處理第 ${i + 1} 筆`);
        try {
            const filePath = await downloadFromOneDrive(href, downloadDir, {
                maxRetries: 3,         // 最多重試 2 次（共跑 3 次）
                timeoutMs: 30000,      // 每次最多等待 10 秒
                retryDelayMs: 1000     // 重試前等待 3 秒
            });
            console.log(`✅ 下載完成：${filePath}`);
            const uploadedUrl = await uploadToImgbox(filePath);
            console.log(`📤 上傳完成：${uploadedUrl}`);
            imgTag.attr('src', uploadedUrl);
        } catch (err) {
            console.error(`❌ 發生錯誤：`, err.message || err);
        }
    }

    fs.writeFileSync(outputHtmlPath, $.html(), 'utf-8');
    console.log(`\n✅ 輸出完成：${outputHtmlPath}`);
})();
