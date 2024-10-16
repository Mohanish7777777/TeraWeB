// index.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const { Telegraf } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 3000;

// Set EJS as templating engine
app.set('view engine', 'ejs');

// Middleware to parse JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Ensure the 'downloads' directory exists
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Initialize Telegram Bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// Route to render the homepage
app.get('/', (req, res) => {
    res.render('index', { downloadUrl: null, watchUrl: null, error: null });
});

// Function to download video
async function downloadVideo(url) {
    try {
        // Step 1: Call the Terabox API to get video details
        const response = await axios.get(`https://teraboxvideodownloader.nepcoderdevs.workers.dev/?url=${encodeURIComponent(url)}`);
        const data = response.data;

        // Step 2: Extract the necessary information from the response
        const resolutions = data.response[0].resolutions;
        const fastDownloadLink = resolutions["Fast Download"];
        const hdDownloadLink = resolutions["HD Video"];
        const videoTitle = data.response[0].title;

        // Step 3: Attempt to download using the Fast Download link
        if (hdDownloadLink) {
            const videoResponse = await axios.get(hdDownloadLink, { responseType: 'stream' });

            // Clean the video title to create a valid filename
            const sanitizedTitle = videoTitle.replace(/[<>:"/\\|?*]/g, '').trim(); // Clean invalid characters
            const videoFilename = `${sanitizedTitle}.mp4`; // You can adjust the extension based on the actual video format

            const videoFilePath = path.join(downloadsDir, videoFilename);

            // Write the video content to a file
            const writer = fs.createWriteStream(videoFilePath);
            videoResponse.data.pipe(writer);

            // Wait for the download to finish
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            console.log(`Video '${videoTitle}' downloaded successfully as '${videoFilename}'.`);
            return videoFilePath; // Return the path of the downloaded video
        } else {
            console.error("No Fast Download link available.");
            return null;
        }
    } catch (error) {
        console.error('Error downloading video:', error.message);
        return null; // Return null in case of error
    }
}

// Route to handle video download requests
app.post('/download', async (req, res) => {
    const { teraUrl } = req.body;

    if (!teraUrl) {
        return res.render('index', { downloadUrl: null, watchUrl: null, error: 'Terabox URL is required.' });
    }

    try {
        const videoFilePath = await downloadVideo(teraUrl);

        if (videoFilePath) {
            // Schedule file deletion after 24 hours
            schedule.scheduleJob(Date.now() + 24 * 60 * 60 * 1000, () => {
                fs.unlink(videoFilePath, (err) => {
                    if (err) console.error(`Error deleting file ${path.basename(videoFilePath)}:`, err);
                    else console.log(`Deleted file ${path.basename(videoFilePath)}`);
                });
            });

            // Upload to Telegram
            await bot.telegram.sendVideo(TELEGRAM_CHANNEL_ID, { source: videoFilePath }, { caption: `Video: ${path.basename(videoFilePath)}` });

            // Create URLs for the user
            const downloadUrl = `${req.protocol}://${req.get('host')}/downloads/${encodeURIComponent(path.basename(videoFilePath))}`;
            const watchUrl = `${req.protocol}://${req.get('host')}/watch/${encodeURIComponent(path.basename(videoFilePath))}`;

            res.render('index', { downloadUrl, watchUrl, error: null });
        } else {
            res.render('index', { downloadUrl: null, watchUrl: null, error: 'Failed to download video. Please ensure the Terabox URL is correct.' });
        }
    } catch (error) {
        console.error('Error in download route:', error.message);
        res.render('index', { downloadUrl: null, watchUrl: null, error: 'Failed to download video. Please try again later.' });
    }
});

// Route to stream video
app.get('/watch/:filename', (req, res) => {
    const { filename } = req.params;
    const filePath = path.join(downloadsDir, filename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Video not found');
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = end - start + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4', // Adjust based on your video format
        };
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4', // Adjust based on your video format
        };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
    }
});

// Serve videos for direct download
app.use('/downloads', express.static(downloadsDir));

// Cleanup job to delete files older than 24 hours (if necessary)
schedule.scheduleJob('0 * * * *', () => { // Runs every hour
    fs.readdir(downloadsDir, (err, files) => {
        if (err) {
            return console.error('Error reading downloads directory:', err);
        }

        files.forEach((file) => {
            const filePath = path.join(downloadsDir, file);
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    return console.error(`Error stating file ${file}:`, err);
                }

                const now = Date.now();
                const fileAge = now - stats.mtimeMs;

                if (fileAge > 24 * 60 * 60 * 1000) { // Older than 24 hours
                    fs.unlink(filePath, (err) => {
                        if (err) {
                            return console.error(`Error deleting file ${file}:`, err);
                        }
                        console.log(`Deleted old file ${file}`);
                    });
                }
            });
        });
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
