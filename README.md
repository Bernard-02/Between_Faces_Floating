# Between Faces Floating

一個瀏覽器內的「漂浮影片拼貼」工具：上傳一批已經做好的 4 秒 ping-pong 短影片（例如 5 張照片做成 1→2→3→4→5→5→4→3→2→1 的循環），就會自動把它們排成漂浮的動態畫面，並可直接匯出成 mp4 / mov / webm。

靈感參考：[Pinterest pin](https://www.pinterest.com/pin/7810999349861810/)

## 快速開始

需要 Python 3（macOS 內建；Windows 可從 python.org 安裝）。

**macOS / Linux**

```bash
./start.sh
```

**Windows**

```
start.bat
```

腳本會在 `http://localhost:8000` 啟動小型 server 並打開瀏覽器。建議用 **Chrome**（Safari 的 MediaRecorder 支援較不穩）。

## 操作流程

1. **上傳素材**：把 4 秒影片檔拖到左上角的拖放區，或點擊選擇檔案（可一次選 83 個）
2. **調整參數**：
   - 背景色
   - 漂浮速度
   - 同屏數量（同時在畫面上的素材數）
   - 輸出時長（秒）
   - 素材最小／最大顯示寬
   - 畫布尺寸（1920×1080、1080×1080、1080×1920、1280×720）
   - 進／退場時間
3. **預覽**：按「▶︎ 預覽」即時看效果，可隨時調參數
4. **匯出**：選輸出格式（mp4 / mov / webm），按「⬇︎ 匯出影片」
   - 錄影為即時錄製，所以匯出 150 秒的影片就需要等 150 秒
   - 之後若選 mp4 / mov，會在瀏覽器內用 ffmpeg.wasm 轉檔（首次會載入 ~20MB）
   - 完成後會自動觸發下載

## 排程邏輯

假設你上傳 N 個影片、總時長 T 秒、同屏數量 K：

- **開場**（前 ~10% 時間）：第一批 K 個錯開進場
- **中段**：剩下的 (N − K) 個依等距排程，從右側陸續進場；每個的存活時間約等於 K × 中段間隔，所以畫面上同時存活的數量穩定在 K 附近
- **結尾**（最後 ~15% 時間）：不再生新的，現存全部慢慢退場

每個素材的 `currentTime` 會隨機設在 0–4 秒，所以 ping-pong 相位不會同步。

## 檔案結構

```
.
├── index.html         # UI（拖放、控制面板、canvas）
├── styles.css
├── sketch.js          # p5.js 主程式：漂浮邏輯 / 排程 / 進退場 / MediaRecorder
├── ffmpeg-worker.js   # 包裝 ffmpeg.wasm 把 webm 轉成 h.264 mp4 / mov
├── start.sh           # macOS / Linux 啟動腳本
└── start.bat          # Windows 啟動腳本
```

外部依賴（CDN，免安裝）：

- [p5.js 1.9.4](https://p5js.org/)
- [@ffmpeg/ffmpeg 0.11.6](https://ffmpegwasm.netlify.app/)（單執行緒版，免 COOP/COEP）

## 已知限制

- **匯出必須即時錄製**：因為用 `MediaRecorder` 抓 canvas 串流，不支援離線快速渲染
- **Safari 支援**：Safari 的 MediaRecorder 只能輸出 mp4 不支援 vp9/vp8 webm，目前優化以 Chrome 為主
- **效能**：83 個 `<video>` 同時建立但只有約 K 個會同時在畫面上播放——如果你的素材碼率很高、機器較弱，可以調小同屏數量或畫布尺寸
