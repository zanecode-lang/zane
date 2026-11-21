const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const PORT = process.env.PORT || 5500;
const isWin = process.platform === "win32";
const YTDLP_PATH = path.join(__dirname, isWin ? "yt-dlp.exe" : "yt-dlp");
const YTDLP_URL = isWin
  ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
  : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

app.use(express.json());
app.use(express.static(__dirname));

function isValidYoutubeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be" ||
      host === "music.youtube.com"
    );
  } catch {
    return false;
  }
}

function sanitizeBaseName(name) {
  const cleaned = String(name || "youtube_audio")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "youtube_audio";
}

function downloadFile(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Quá nhiều lần chuyển hướng khi tải yt-dlp"));
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(downloadFile(res.headers.location, destPath, redirects + 1));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Tải yt-dlp thất bại (HTTP ${res.statusCode})`));
        }
        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => fileStream.close(resolve));
        fileStream.on("error", reject);
      })
      .on("error", reject);
  });
}

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH) && fs.statSync(YTDLP_PATH).size > 1000000) {
    if (!isWin) fs.chmodSync(YTDLP_PATH, 0o755);
    return YTDLP_PATH;
  }
  const tmpBin = `${YTDLP_PATH}.tmp`;
  await downloadFile(YTDLP_URL, tmpBin);
  fs.renameSync(tmpBin, YTDLP_PATH);
  if (!isWin) fs.chmodSync(YTDLP_PATH, 0o755);
  return YTDLP_PATH;
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_PATH, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr || err.message || "Lỗi thực thi yt-dlp"));
      }
      resolve({ stdout, stderr });
    });
  });
}

app.post("/api/ytb-to-mp3", async (req, res) => {
  const { url, bitrate } = req.body || {};
  const allowedBitrates = ["128", "192", "256", "320"];
  const kbps = allowedBitrates.includes(String(bitrate)) ? String(bitrate) : "192";

  if (!url || !isValidYoutubeUrl(url.trim())) {
    return res.status(400).json({ error: "Link YouTube không hợp lệ." });
  }

  const cleanUrl = url.trim();
  const jobId = `ytb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = os.tmpdir();
  const outTemplate = path.join(tmpDir, `${jobId}.%(ext)s`);
  const finalMp3Path = path.join(tmpDir, `${jobId}.mp3`);

  try {
    await ensureYtDlp();

    let title = "youtube_audio";
    try {
      const { stdout } = await runYtDlp([
        cleanUrl,
        "--dump-single-json",
        "--no-warnings",
        "--no-playlist"
      ]);
      const meta = JSON.parse(stdout);
      if (meta && meta.title) title = meta.title;
    } catch {}

    const args = [
      cleanUrl,
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      `${kbps}K`,
      "-o",
      outTemplate,
      "--no-playlist",
      "--no-warnings"
    ];
    if (ffmpegPath) {
      args.push("--ffmpeg-location", ffmpegPath);
    }

    await runYtDlp(args);

    const createdFile = fs.existsSync(finalMp3Path)
      ? finalMp3Path
      : fs
          .readdirSync(tmpDir)
          .map((f) => path.join(tmpDir, f))
          .find((p) => p.startsWith(path.join(tmpDir, jobId)) && p.endsWith(".mp3"));

    if (!createdFile || !fs.existsSync(createdFile)) {
      return res.status(500).json({ error: "Không xuất được file MP3 từ link YouTube." });
    }

    const downloadName = `${sanitizeBaseName(title)}_${kbps}kbps.mp3`;
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
    res.setHeader("X-Output-Filename", encodeURIComponent(downloadName));

    const stream = fs.createReadStream(createdFile);
    stream.on("close", () => {
      fs.unlink(createdFile, () => {});
    });
    stream.pipe(res);
  } catch (err) {
    try {
      fs.readdirSync(tmpDir)
        .filter((f) => f.startsWith(jobId))
        .forEach((f) => fs.unlink(path.join(tmpDir, f), () => {}));
    } catch {}
    res.status(500).json({ error: err?.message || "Lỗi khi lọc MP3 từ link YouTube." });
  }
});

app.listen(PORT, () => {
  console.log(`Server chạy tại http://localhost:${PORT}`);
});