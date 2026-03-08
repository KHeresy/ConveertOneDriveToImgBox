const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const cheerio = require('cheerio');
const { imgbox } = require('imgbox-js');
const OneDrive = require('./onedrive_dl');

const args = minimist(process.argv.slice(2), {
    string: ['input', 'output', 'dir', 'title', 'resume_data', 'url', 'user-data'],
    boolean: ['login', 'replace-link'],
    default: {
        input: 'wordpress.html',
        output: 'output.html',
        img_dir: './downloads',
        title: 'no-title',
        upload_retries: 5,
        max_download_failures: 2,
        resume_data: 'cache.json'
    }
});

const od_options = {
    maxRetries: 2,
    timeoutMs: 30000,
    retryDelayMs: 2000
};

const downloadDir = path.resolve(args.img_dir);

// --- Prepare OneDrive Downloader Options ---
const downloaderOptions = {};
if (args['user-data']) {
    const userDataPath = path.resolve(args['user-data']);
    downloaderOptions.userDataDir = userDataPath;
    console.log(`💡 Using user data directory: ${downloaderOptions.userDataDir}`);
}

// --- Login mode ---
if (args.login) {
    if (!downloaderOptions.userDataDir) {
        console.error('❌ Error: --user-data is required for --login mode.');
        process.exit(1);
    }
    (async () => {
        const downloader = new OneDrive();
        try {
            await downloader.login(downloaderOptions);
        } catch (error) {
            console.error(`❌ Login process failed: ${error.message}`);
            process.exit(1);
        }
    })();
} else if (args.url) {
    // --- Single URL download mode ---
    (async () => {
        console.log(`單獨下載模式：${args.url}`);
        const downloader = new OneDrive();
        await downloader.initialize({ ...downloaderOptions, headless: true });
        try {
            if (!fs.existsSync(downloadDir)) {
                fs.mkdirSync(downloadDir, { recursive: true });
            }
            const filePath = await downloader.download(args.url, downloadDir, od_options);
            console.log(`✅ 下載完成：${filePath}`);
        } catch (error) {
            console.error(`❌ 下載失敗: ${error.message}`);
            process.exit(1);
        } finally {
            await downloader.close();
        }
    })();
} else {
    // --- Original logic for processing HTML file ---
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

    // --- 從圖片 src 的 query string 設定長寬 ---
    $('img').each((_, el) => {
        const imgTag = $(el);
        const src = imgTag.attr('src');

        if (!src) return;

        // 如果圖片標籤已經有 width 或 height 屬性，則跳過
        if (imgTag.attr('width') || imgTag.attr('height')) {
            return;
        }

        const qIndex = src.indexOf('?');
        if (qIndex === -1) {
            return;
        }

        try {
            // 使用 URLSearchParams 安全地解析 query string
            const params = new URLSearchParams(src.substring(qIndex));
            const width = params.get('width');
            const height = params.get('height');

            if (width && height) {
                console.log(`🎨 套用寬高 ${width}x${height} 至圖片: ${src.substring(0, 60)}...`);
                imgTag.attr('width', width);
                imgTag.attr('height', height);
            }
        } catch (e) {
            console.warn(`⚠️ 無法解析圖片 src 的 query string: ${src}`);
        }
    });

    const hrefToImgTags = new Map();
    const srcToHref = new Map();

    // First pass: build src -> href map from all valid <a> tags
    $('a').each((_, el) => {
        const href = $(el).attr('href');
        const img = $(el).find('img');
        const src = img.attr('src') || '';

        if (href && (href.startsWith('https://1drv.ms/') || href.startsWith('https://onedrive.live.com/?cid=')) && src) {
            const baseUrl = src.split('?')[0];
            if (!srcToHref.has(baseUrl)) {
                srcToHref.set(baseUrl, href);
            }
        }
    });

    // Second pass: iterate all images and group them by download href
    $('img').each((_, el) => {
        const imgTag = $(el);
        const src = imgTag.attr('src') || '';

        if (!src || src.includes('imgbox.com')) {
            return; // Skip already processed or empty src images
        }

        const baseUrl = src.split('?')[0];
        const parentA = imgTag.parent('a');
        let href = '';

        // Try to get href from parent <a> tag first
        if (parentA.length > 0) {
            const parentHref = parentA.attr('href');
            if (parentHref && (parentHref.startsWith('https://1drv.ms/') || parentHref.startsWith('https://onedrive.live.com/?cid='))) {
                href = parentHref;
            }
        }

        // If no suitable parent <a>, try to find a link from the map
        if (!href) {
            href = srcToHref.get(baseUrl);
        }

        if (href) {
            if (!hrefToImgTags.has(href)) {
                hrefToImgTags.set(href, []);
            }
            hrefToImgTags.get(href).push(imgTag);
        }
    });

    // Now, create the allTasks array from the map
    const allTasks = [];
    for (const [href, imgTags] of hrefToImgTags.entries()) {
        allTasks.push({ href, imgTags });
    }

    const total = allTasks.length;
    console.log(`📦 共找到 ${total} 個獨立的 OneDrive 連結，對應多個圖片。`);

    const resumeFile = args.resume_data;
    let resumeMap = new Map();
    if (fs.existsSync(resumeFile)) {
        try {
            const resumeData = JSON.parse(fs.readFileSync(resumeFile, 'utf-8'));
            resumeMap = new Map(resumeData.map(entry => {
                const isNested = typeof entry.filename === 'object' && entry.filename !== null;
                const data = {
                    filename: isNested ? entry.filename.filename : entry.filename,
                    imgbox_url: isNested ? entry.filename.imgbox_url : entry.imgbox_url,
                    imgbox_thumbnail_url: isNested ? entry.filename.imgbox_thumbnail_url : entry.imgbox_thumbnail_url,
                };
                return [entry.href, data];
            }));
            console.log(`🔄 已載入 resume 檔案 (${resumeMap.size} 筆)`);
        } catch (err) {
            console.warn('⚠️ resume.json 解析失敗，將忽略。');
        }
    }

    const imagesForUpload = [];
    const tasksWithFiles = [];
    const failedHrefs = [];

    (async () => {
        const downloader = new OneDrive();
        await downloader.initialize({ ...downloaderOptions, headless: true });

        try {
            for (const [index, { href, imgTags }] of allTasks.entries()) {
                console.log(`🔄 處理第 ${index + 1} / ${total} 個連結: ${href}`);

                let filePath;

                if (resumeMap.has(href)) {
                    const cached = resumeMap.get(href);
                    if (cached.imgbox_url && cached.imgbox_thumbnail_url) {
                        console.log(`✅ 使用快取中的 imgbox 連結: ${cached.imgbox_thumbnail_url}`);
                        for (const imgTag of imgTags) {
                            const aTag = imgTag.parent();
                            const originalSrc = imgTag.attr('src');
                            if (args['replace-link']) {
                                const originalHref = aTag.attr('href');
                                imgTag.before(`<!-- backup: href="${originalHref}" src="${originalSrc}" -->`);
                                aTag.attr('href', cached.imgbox_url);
                            } else {
                                imgTag.before(`<!-- backup: src="${originalSrc}" -->`);
                            }
                            imgTag.attr('src', cached.imgbox_thumbnail_url);
                        }
                        continue;
                    }

                    const existingFile = path.join(downloadDir, cached.filename);
                    if (fs.existsSync(existingFile)) {
                        filePath = existingFile;
                        console.log(`✅ 使用已存在檔案：${filePath}`);
                    } else {
                        console.warn(`⚠️ 找不到 resume 檔案，重新下載：${existingFile}`);
                    }
                }

                if (!filePath) {
                    try {
                        // 1. Create a temporary directory for download
                        const tempDownloadDir = path.join(downloadDir, 'temp_download');
                        if (fs.existsSync(tempDownloadDir)) {
                            fs.rmSync(tempDownloadDir, { recursive: true, force: true });
                        }
                        fs.mkdirSync(tempDownloadDir, { recursive: true });

                        // 2. Download the file into the temporary directory
                        const tempFilePath = await downloader.download(href, tempDownloadDir, od_options);
                        
                        if (!tempFilePath || !fs.existsSync(tempFilePath)) {
                             throw new Error('Download failed, temporary file not found.');
                        }

                        // 3. Determine the final path with conflict resolution
                        const originalFilename = path.basename(tempFilePath);
                        let finalFilePath = path.join(downloadDir, originalFilename);
                        let counter = 1;
                        const basename = path.basename(originalFilename, path.extname(originalFilename));
                        const extname = path.extname(originalFilename);

                        while (fs.existsSync(finalFilePath)) {
                            finalFilePath = path.join(downloadDir, `${basename}_${counter}${extname}`);
                            counter++;
                        }

                        // 4. Move the file to the final destination
                        fs.renameSync(tempFilePath, finalFilePath);

                        // 5. Clean up the temporary directory
                        fs.rmSync(tempDownloadDir, { recursive: true, force: true });
                        
                        filePath = finalFilePath;
                        resumeMap.set(href, {filename: path.basename(filePath)});
                        console.log(`✅ 下載完成：${filePath}`);
                    } catch (err) {
                        console.error(`❌ 下載失敗：${err.message || err}`);
                        failedHrefs.push(href);
                        if (failedHrefs.length > args.max_download_failures) {
                            console.error(`🚨 下載失敗數超過上限 (${args.max_download_failures})，終止程序。`);
                            const resumeArray = Array.from(resumeMap.entries()).map(([href, data]) => ({ href, ...data }));
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
                for (const imgTag of imgTags) {
                    tasksWithFiles.push({ filename: fileName, imgTag });
                }
            }

            

            if (imagesForUpload.length > 0) {
                const uploadedMap = new Map();
                const chunkSize = 40;

                for (let i = 0; i < imagesForUpload.length; i += chunkSize) {
                    const chunk = imagesForUpload.slice(i, i + chunkSize);
                    console.log(`🚀 上傳第 ${i / chunkSize + 1} 批，共 ${chunk.length} 張圖片至 imgbox...`);

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
                            const key = path.basename(item.name, path.extname(item.name));
                            uploadedMap.set(key.toLowerCase(), { url: item.url, thumbnail_url: item.thumbnail_url });

                            for (const [href, cacheEntry] of resumeMap.entries()) {
                                const cacheFilename = path.basename(cacheEntry.filename, path.extname(cacheEntry.filename));
                                if (cacheFilename.toLowerCase() === key.toLowerCase()) {
                                    cacheEntry.imgbox_url = item.url;
                                    cacheEntry.imgbox_thumbnail_url = item.thumbnail_url;
                                    break;
                                }
                            }
                        }
                    }

                    if (i + chunkSize < imagesForUpload.length) {
                        console.log(`⏳ 等待 5 秒後繼續下一批...`);
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }

                let failMapping = false;
                for (const { filename, imgTag } of tasksWithFiles) {
                    const filenameNoExt = path.basename(filename, path.extname(filename));
                    // imgbox 正規化檔名：轉小寫、替換空格和括號為底線
                    const normalizedFilename = filenameNoExt.toLowerCase().replace(/[\s\+()]/g, '_');
                    const urls = uploadedMap.get(normalizedFilename);

                    if (urls) {
                        const aTag = imgTag.parent();
                        const originalSrc = imgTag.attr('src');

                        if (args['replace-link']) {
                            const originalHref = aTag.attr('href');
                            imgTag.before(`<!-- backup: href="${originalHref}" src="${originalSrc}" -->`);
                            aTag.attr('href', urls.url);
                        } else {
                            imgTag.before(`<!-- backup: src="${originalSrc}" -->`);
                        }
                        imgTag.attr('src', urls.thumbnail_url);
                    } else {
                        console.warn(`⚠️ 找不到上傳成功的對應網址：${filename} (normalized: ${normalizedFilename})`);
                        failMapping = true;
                    }
                }

                if (failMapping) {
                    console.log("--- Uploaded URL Mapping ---");
                    for (const [key, value] of uploadedMap.entries()) {
                        console.log(`${key}: ${JSON.stringify(value)}`);
                    }
                    console.log("--------------------------");
                }
            }

            const finalResumeArray = Array.from(resumeMap.entries()).map(([href, data]) => ({ href, ...data }));
            fs.writeFileSync(resumeFile, JSON.stringify(finalResumeArray, null, 2));
            console.log(`📄 已將最終快取資訊儲存至 ${resumeFile}`);

            fs.writeFileSync(args.output, $.html(), 'utf-8');
            console.log(`✅ 已輸出修改後的 HTML 至：${args.output}`);
        } finally {
            await downloader.close();
        }
    })();
}
