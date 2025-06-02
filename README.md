# 將 HTML 網頁裡的 OneDrive 內嵌圖片轉移到 Imgbox

## 緣由

OneDrive 在 2023 年把內嵌圖片的連結改成比較像是 API 的形式（[參考](https://kheresy.wordpress.com/2023/06/30/onedrive-image-embed-link-changed/)）後、圖檔讀取過程就需要數次的網頁重新導向、顯示出來的速度就很慢了。

前一陣子，也才發現微軟把部分早期 OneDrive 的內嵌圖片連結搞爛了（[參考](https://kheresy.wordpress.com/2025/05/11/some-embed-image-of-onedrive-fail/)），所以 Heresy 的部落格有一堆圖片都變成無法顯示了。

而和微軟客服連絡後，基本上完全沒有想要處理的打算，就直接說無法處理、要客戶自己重新弄。

所以後來決定放棄繼續把 OneDrive 當圖床、暫時先改用 https://imgbox.com/ 來做為新的圖床。

而這個腳本，就是用來把現有的網頁做批次轉換用的；不過，大部分的程式都是 ChatGPT 寫的，這邊也只是調整到盡量可以正常運作而已。

## 程式流程

主程式是 `proc_od_img.js`，基本執行的方法是： 

  ```
  node .\proc_od_img.js --input wordpress.html --output output.html --title "相簿名稱"
  ```

流程大致如下：

1. 分析 HTML、把網頁中 `<a href="https://1drv.ms/XXXX" XXX><img XXXX></a>` 的連結都找出來
2. 針對每一個找到的連結、透過 `onedrive_dl.js` 來下載
   - 目前支援 `https://1drv.ms/u/s!XXX` 和 `https://1drv.ms/i/s!` 兩種形式的分享網址
   - 內部實作是透過 `puppeteer` 去開一個瀏覽器、讓他真的去做網頁重新導向，最後再用模擬人類操作的方式去點下載連結
   - 會去比對 `resume.json`，裡面記錄了處理過的網址與對應的圖檔，這樣可以避免重新下載
3. 圖檔都下載完後，透過 `imgbox-js` 批次上傳到 Imgbox
   - 測試的時候一次好像只能上傳 50 張，過多會失敗
   - 可能是 `imgbox-js` 本身的限制，每批上傳都會建立一個新相簿、不能放在同一個相簿
4. 去查詢 imgbox 回傳的結果，將網頁中的內嵌圖檔替換成 imgbox 的縮圖連結
   - 這邊沒有把分享連結替換掉，有需要請自己改
5. 輸出修改過的 HTML

## 已知問題

- OneDrive 的部分
  - 大量處理過後可能會被 OneDrive 封鎖一段時間、導致無法下載
  - `puppeteer` 似乎沒有提供 API 可以判斷檔案是否下載完成，所以這邊是用檢查檔案是否存在的方式來判斷是否下載完成
  - 不知道為什麼，有可能 `onedrive_dl.js` 判斷有檔案，但是實際上沒有；所以這邊在 `proc_od_img.js` 會再檢查一次。
- 應該是 `imgbox-js` 的限制
  - 批次上傳到 imgbox 會建立相簿、但是每批都會建立一個相簿（同名）
  - 相簿內顯示的照片數量缺少很多，但是實際上圖檔都在（原因不明）
  - 整批上傳的參數都會完全一樣、不能個別調整
