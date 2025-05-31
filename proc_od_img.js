const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const cheerio = require('cheerio');
const { imgbox } = require('imgbox-js');
const { downloadFromOneDrive } = require('./onedrive_dl');

// 設定路徑與參數
const args = minimist(process.argv.slice(2), {
    string: ['input', 'output', 'dir'],
    default: {
        input: 'wordpress.html',
        output: 'output.html',
        img_dir: './downloads',
        title: "no-title"
    }
});

const downloadDir = path.resolve(args.img_dir);
const imgboxAuthCookie = process.env.IMGBOX_COOKIE;

if (!imgboxAuthCookie) {
    console.error('❌ 未提供 IMGBOX_COOKIE，請先設定環境變數。');
    process.exit(1);
}

if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
}

// === 讀取與分析 HTML ===
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

// === 準備上傳與對應資料 ===
const imagesForUpload = [];           // 給 imgbox 批次上傳
const tasksWithFiles = [];            // 給後續 src 替換用

(async () => {
    for (const [index, { href, imgTag }] of tasks.entries()) {
        console.log(`\n🔄 處理第 ${index + 1} / ${total} 筆`);

        try {
            const filePath = await downloadFromOneDrive(href, downloadDir, {
                maxRetries: 2,
                timeoutMs: 15000,
                retryDelayMs: 2000
            });

            const fileName = path.basename(filePath);                         // 含副檔名
            const fileNameNoExt = path.basename(filePath, path.extname(filePath)); // 不含副檔名

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

    // === 上傳至 imgbox ===
    console.log(`\n🚀 開始批次上傳 ${imagesForUpload.length} 張圖片至 imgbox...`);

    const uploadOptions = {
        auth_cookie: imgboxAuthCookie,
        album_title: args.title,
        content_type: 'safe',
        thumbnail_size: '800r',
        comments_enabled: false,
        logger: true
    };

    const uploadRes = await imgbox(imagesForUpload, uploadOptions);
    const uploadedMap = new Map(); // name => url
    const failedNames = [];

    if (uploadRes && uploadRes.data && Array.isArray(uploadRes.data.success)) {
        for (const item of uploadRes.data.success) {
            uploadedMap.set(item.name, item.thumbnail_url); // 或 original_url
        }

        if (Array.isArray(uploadRes.data.failed)) {
            for (const f of uploadRes.data.failed) {
                failedNames.push(f.name);
            }
        }
    } else {
        console.error('❌ 上傳回傳格式錯誤，imgbox 返回：', uploadRes);
        process.exit(1);
    }

    // === 以檔案名稱比對替換 HTML 的 <img src> ===
    let successCount = 0;

    for (const { filename, imgTag } of tasksWithFiles) {
        const url = uploadedMap.get(filename);
        if (url) {
            imgTag.attr('src', url);
            successCount++;
        } else {
            failedNames.push(filename);
        }
    }

    // === 輸出 HTML ===
    fs.writeFileSync(args.output, $.html(), 'utf-8');
    console.log(`\n✅ 已輸出修改後的 HTML 至：${args.output}`);
    console.log(`🎉 成功處理 ${successCount} / ${total} 張圖片`);

    // === 輸出失敗清單 ===
    if (failedNames.length > 0) {
        console.log('\n⚠️ 以下圖片未成功上傳或替換：');
        failedNames.forEach(f => console.log(' - ' + f));
        fs.writeFileSync('failed.txt', failedNames.join('\n'), 'utf-8');
        console.log('📝 已將失敗清單輸出至 failed.txt');
    }
})();
