const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const cheerio = require('cheerio');
const { imgbox } = require('imgbox-js');
const { downloadFromOneDrive } = require('./onedrive_dl');

// === 設定參數 ===
const args = minimist(process.argv.slice(2), {
    string: ['input', 'output', 'dir', 'title'],
    default: {
        input: 'wordpress.html',
        output: 'output.html',
        img_dir: './downloads',
        title: 'no-title',
        upload_retries: 5
    }
});

const od_options = {
    maxRetries: 2,
    timeoutMs: 15000,
    retryDelayMs: 2000
};

const downloadDir = path.resolve(args.img_dir);
const imgboxAuthCookie = process.env.IMGBOX_COOKIE;

if (!imgboxAuthCookie) {
    console.error('❌ 未提供 IMGBOX_COOKIE，請先設定環境變數。');
    process.exit(1);
}

if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
}

// === 分析 HTML ===
const html = fs.readFileSync(args.input, 'utf-8');
const $ = cheerio.load(html);
const tasks = [];

$('a').each((_, el) => {
    const href = $(el).attr('href');
    const img = $(el).find('img');
    if (href && href.startsWith('https://1drv.ms/u/s!') && img.length > 0) {
        tasks.push({ href, imgTag: $(img) });
    }
});

const total = tasks.length;
console.log(`📦 共找到 ${total} 筆 OneDrive 圖片`);

// === 建立圖片上傳任務列表 ===
const imagesForUpload = [];
const tasksWithFiles = [];

(async () => {
    for (const [index, { href, imgTag }] of tasks.entries()) {
        console.log(`\n🔄 處理第 ${index + 1} / ${total} 筆`);
        try {
            const filePath = await downloadFromOneDrive(href, downloadDir, od_options);

            let retryCount = 0;
            while (!fs.existsSync(filePath)) {
                console.log(`❌ 原因不明的下載失敗`);
                if (++retryCount > 5)
                    break;
                await downloadFromOneDrive(href, downloadDir, od_options);
            }

            const fileName = path.basename(filePath);
            const fileNameNoExt = path.basename(filePath, path.extname(filePath));

            imagesForUpload.push({
                source: filePath,
                filename: fileNameNoExt
            });

            tasksWithFiles.push({
                filename: fileName,
                imgTag
            });

            console.log(`✅ 下載完成：${fileName}`);
        } catch (err) {
            console.error(`❌ 下載失敗：${err.message || err}`);
        }
    }

    // === 上傳圖片（包含失敗重試） ===
    let uploadRes = null;
    let failedItems = [];
    let retryCount = Number(args.upload_retries) || 1;

    for (let attempt = 1; attempt <= retryCount + 1; attempt++) {
        if (attempt > 1 && failedItems.length === 0) break;

        const currentUploadList = attempt === 1 ? imagesForUpload : failedItems;

        if (attempt > 1) {
            console.log(`\n🔁 重新上傳失敗的圖片（第 ${attempt} 次）...`);
        } else {
            console.log(`\n🚀 開始批次上傳 ${currentUploadList.length} 張圖片至 imgbox...`);
        }

        try {
            uploadRes = await imgbox(currentUploadList, {
                auth_cookie: imgboxAuthCookie,
                album_title: args.title,
                content_type: 'safe',
                thumbnail_size: '800r',
                comments_enabled: false,
                logger: true
            });

            // 重新建立 map 與失敗清單
            if (!uploadRes || !uploadRes.data || !Array.isArray(uploadRes.data.success)) {
                throw new Error('imgbox 回傳格式錯誤');
            }

            fs.writeFileSync('upload_debug.json', JSON.stringify(uploadRes, null, 2), 'utf-8');

            // 成功的圖片記錄
            const uploadedMap = new Map();
            for (const item of uploadRes.data.success) {
                uploadedMap.set(item.name.toLowerCase(), item.thumbnail_url);
            }

            // 失敗的圖
            failedItems = [];
            if (Array.isArray(uploadRes.data.failed)) {
                for (const f of uploadRes.data.failed) {
                    const failedSource = currentUploadList.find(i => i.filename + path.extname(i.source) === f.name);
                    if (failedSource) {
                        failedItems.push(failedSource);
                    }
                }
            }

            // 替換 HTML 中的 <img src>
            let failCount = 0;
            for (const { filename, imgTag } of tasksWithFiles) {
                const url = uploadedMap.get(filename.toLowerCase());
                if (url) {
                    imgTag.attr('src', url);
                }
                else {
                    ++failCount;
                    console.log(`${filename} 找不到新的網址`);

                }
            }
            if (failCount > 0) {
                uploadedMap.forEach((value, key) => {
                    console.log(`${key}: ${value}`);
                });
            }

            console.log(`\n✅ 第 ${attempt} 次上傳成功數：${uploadRes.data.success.length}`);
            if (failedItems.length > 0) {
                console.log(`⚠️ 第 ${attempt} 次上傳失敗 ${failedItems.length} 張`);
            }

        } catch (err) {
            console.error(`❌ 上傳失敗（第 ${attempt} 次）：`, err.message || err);
            break;
        }
    }

    // === 輸出 HTML ===
    fs.writeFileSync(args.output, $.html(), 'utf-8');
    console.log(`\n✅ 已輸出修改後的 HTML 至：${args.output}`);

    // === 錯誤處理與輸出 debug 資訊 ===
    if (failedItems.length > 0) {
        const failedNames = failedItems.map(f => path.basename(f.source));
        console.log('\n⚠️ 以下圖片未成功上傳或替換：');
        failedNames.forEach(name => console.log(' - ' + name));
        fs.writeFileSync('failed.txt', failedNames.join('\n'), 'utf-8');
        console.log('📝 已將失敗清單輸出至 failed.txt');

        // 輸出完整 uploadRes 以利除錯
        fs.writeFileSync('upload_debug.json', JSON.stringify(uploadRes, null, 2), 'utf-8');
        console.log('🧪 已將 imgbox 回傳內容輸出至 upload_debug.json');
    }
})();
