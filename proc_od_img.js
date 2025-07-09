const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const cheerio = require('cheerio');
const { imgbox } = require('imgbox-js');
const OneDrive = require('./onedrive_dl'); // Changed: Import the class

const args = minimist(process.argv.slice(2), {
    string: ['input', 'output', 'dir', 'title', 'resume_data'],
    default: {
        input: 'wordpress.html',
        output: 'output.html',
        img_dir: './downloads',
        title: 'no-title',
        upload_retries: 5,
        max_download_failures: 2,
        resume_data: 'resume.json'
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

const html = fs.readFileSync(args.input, 'utf-8');
const $ = cheerio.load(html);

const allTasks = [];
$('a').each((_, el) => {
    const href = $(el).attr('href');
    const img = $(el).find('img');
    const src = img.attr('src') || '';
    if (
        href &&
        href.startsWith('https://1drv.ms/') &&
        img.length > 0 &&
        !src.includes('imgbox.com')
    ) {
        allTasks.push({ href, imgTag: $(img) });
    }
});

const total = allTasks.length;
console.log(`📦 共找到 ${total} 筆 OneDrive 圖片`);

const resumeFile = args.resume_data;
let resumeMap = new Map();
if (fs.existsSync(resumeFile)) {
    try {
        const resumeData = JSON.parse(fs.readFileSync(resumeFile, 'utf-8'));
        resumeMap = new Map(resumeData.map(entry => [entry.href, entry.filename]));
        console.log(`🔄 已載入 resume 檔案 (${resumeMap.size} 筆)`);
    } catch (err) {
        console.warn('⚠️ resume.json 解析失敗，將忽略。');
    }
}

const imagesForUpload = [];
const tasksWithFiles = [];
const failedHrefs = [];

(async () => {
    // Changed: Initialize OneDrive downloader
    const downloader = new OneDrive();
    await downloader.initialize({ headless: true });

    try {
        for (const [index, { href, imgTag }] of allTasks.entries()) {
            console.log(`\n🔄 處理第 ${index + 1} / ${total} 筆`);

            let filePath;

            if (resumeMap.has(href)) {
                const existingFile = path.join(downloadDir, resumeMap.get(href));
                if (fs.existsSync(existingFile)) {
                    filePath = existingFile;
                    console.log(`✅ 使用已存在檔案：${filePath}`);
                } else {
                    console.warn(`⚠️ 找不到 resume 檔案，重新下載：${existingFile}`);
                }
            }

            if (!filePath) {
                try {
                    // Changed: Use the downloader instance. Removed the redundant while loop.
                    filePath = await downloader.download(href, downloadDir, od_options);
                    resumeMap.set(href, path.basename(filePath));
                    console.log(`✅ 下載完成：${filePath}`);
                } catch (err) {
                    console.error(`❌ 下載失敗：${err.message || err}`);
                    failedHrefs.push(href);
                    if (failedHrefs.length > args.max_download_failures) {
                        console.error(`🚨 下載失敗數超過上限 (${args.max_download_failures})，終止程序。`);
                        // Save resume data before exiting
                        const resumeArray = Array.from(resumeMap.entries()).map(([href, filename]) => ({ href, filename }));
                        fs.writeFileSync(resumeFile, JSON.stringify(resumeArray, null, 2));
                        console.log(`📄 已儲存 resume 資訊至 ${resumeFile}`);
                        process.exit(1);
                    }
                    continue;
                }
            }

            const fileName = path.basename(filePath);
            const fileNameNoExt = path.basename(filePath, path.extname(filePath));

            imagesForUpload.push({ source: filePath, filename: fileNameNoExt });
            tasksWithFiles.push({ filename: fileName, imgTag });
        }

        const resumeArray = Array.from(resumeMap.entries()).map(([href, filename]) => ({ href, filename }));
        fs.writeFileSync(resumeFile, JSON.stringify(resumeArray, null, 2));
        console.log(`📄 已更新 resume 資訊至 ${resumeFile}`);

        // === Batch Upload ===
        if (imagesForUpload.length > 0) {
            const uploadedMap = new Map();
            const chunkSize = 40;

            for (let i = 0; i < imagesForUpload.length; i += chunkSize) {
                const chunk = imagesForUpload.slice(i, i + chunkSize);
                console.log(`\n🚀 上傳第 ${i / chunkSize + 1} 批，共 ${chunk.length} 張圖片至 imgbox...`);

                const uploadRes = await imgbox(chunk, {
                    auth_cookie: imgboxAuthCookie,
                    album_title: args.title,
                    content_type: 'safe',
                    thumbnail_size: '800r',
                    comments_enabled: false,
                    logger: true
                });

                fs.writeFileSync(`upload_debug_batch_${i / chunkSize + 1}.json`, JSON.stringify(uploadRes, null, 2), 'utf-8');

                if (uploadRes && uploadRes.data && Array.isArray(uploadRes.data.success)) {
                    for (const item of uploadRes.data.success) {
                        uploadedMap.set(item.name.toLowerCase(), item.thumbnail_url);
                    }
                }

                if (i + chunkSize < imagesForUpload.length) {
                    console.log(`⏳ 等待 5 秒後繼續下一批...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }

            let failMapping = false;
            for (const { filename, imgTag } of tasksWithFiles) {
                const url = uploadedMap.get(filename.toLowerCase());
                if (url) {
                    imgTag.before(`<!-- backup: ${imgTag.attr('src')} -->`);
                    imgTag.attr('src', url);
                } else {
                    console.warn(`⚠️ 找不到上傳成功的對應網址：${filename}`);
                    failMapping = true;
                }
            }

            if (failMapping) {
                console.log("--- Uploaded URL Mapping ---");
                for (const [key, value] of uploadedMap) {
                    console.log(`${key}: ${value}`);
                }
                console.log("--------------------------");
            }
        }

        fs.writeFileSync(args.output, $.html(), 'utf-8');
        console.log(`\n✅ 已輸出修改後的 HTML 至：${args.output}`);

    } finally {
        // Changed: Ensure browser is closed
        await downloader.close();
    }
})();
