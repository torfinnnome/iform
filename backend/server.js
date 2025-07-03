
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = 3000;

// --- CONFIGURATION ---
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const REDIRECT_URI = process.env.REDIRECT_URI;
const GEMINI_MODEL = process.env.GEMINI_MODEL;
const SESSION_SECRET = process.env.SESSION_SECRET;

// --- INITIALIZATION ---
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
// const model = genAI.getGenerativeModel({ model: "gemini-1.0-pro" });
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

// --- MIDDLEWARE ---
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' } // Use secure cookies in production
}));

app.use((req, res, next) => {
    const now = new Date().toISOString();
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    console.log(`[${now}] ${ip} - ${req.method} ${req.originalUrl}`);
    next();
});
app.use(express.static(path.join(__dirname, '../frontend')));
app.use(express.json()); // To parse JSON bodies

// --- API ENDPOINTS ---

// Language translations
app.get('/api/lang/:lang', (req, res) => {
    const lang = req.params.lang;
    const langFilePath = path.join(__dirname, `locales/${lang}.json`);
    fs.readFile(langFilePath, 'utf8', (err, data) => {
        if (err) {
            return res.status(404).send({ error: 'Language not found' });
        }
        res.send(JSON.parse(data));
    });
});

// Strava authentication status
app.get('/api/strava/status', (req, res) => {
    res.send({ authenticated: !!req.session.stravaTokens });
});

app.get('/api/github_url', (req, res) => {
    res.send({ url: process.env.GITHUB_URL });
});

// Strava connect redirect
app.get('/api/strava/connect', (req, res) => {
    const stravaAuthUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=read,activity:read_all`;
    res.redirect(stravaAuthUrl);
});

// Strava callback
app.get('/api/strava/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).send('Authorization code is missing.');
    }
    try {
        const response = await axios.post('https://www.strava.com/oauth/token', {
            client_id: STRAVA_CLIENT_ID,
            client_secret: STRAVA_CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
        });
        req.session.stravaTokens = {
            accessToken: response.data.access_token,
            refreshToken: response.data.refresh_token,
            expiresAt: response.data.expires_at
        };
        res.redirect('/');
    } catch (error) {
        console.error('Error exchanging authorization code:', error.response ? error.response.data : error.message);
        res.status(500).send('Failed to authenticate with Strava.');
    }
});

// Fetch Strava activities
app.get('/api/strava/activities', async (req, res) => {
    if (!req.session.stravaTokens || !req.session.stravaTokens.accessToken) {
        return res.status(401).send({ error: 'Not authenticated with Strava.' });
    }
    // A robust implementation would handle token refresh
    const sixMonthsAgo = Math.floor(new Date(new Date().setMonth(new Date().getMonth() - 6)).getTime() / 1000);
    try {
        const response = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
            headers: { Authorization: `Bearer ${req.session.stravaTokens.accessToken}` },
            params: { after: sixMonthsAgo, per_page: 200 }
        });
        res.send(response.data);
    } catch (error) {
        console.error('Error fetching Strava activities:', error.response ? error.response.data : error.message);
        res.status(500).send({ error: 'Failed to fetch activities from Strava.' });
    }
});

// Analyze activities with Google Gemini
app.post('/api/analyze/activities', async (req, res) => {
    const { activities, lang, special_considerations } = req.body;

    if (!activities || activities.length === 0) {
        return res.status(400).send({ error: 'No activities provided for analysis.' });
    }

    const prompt = generateAnalysisPrompt(activities, lang, special_considerations);

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        // Clean the response to get valid JSON
        const jsonResponse = text.match(/```json\n([\s\S]*?)\n```/);
        if (jsonResponse && jsonResponse[1]) {
            const parsedAnalysis = JSON.parse(jsonResponse[1]);
            res.send(parsedAnalysis);
        } else {
            throw new Error("AI response was not in the expected JSON format.");
        }
    } catch (error) {
        console.error('Error analyzing activities with Gemini:', error);
        res.status(500).send({ error: 'Failed to analyze activities.' });
    }
});


// --- HELPER FUNCTIONS ---
function generateAnalysisPrompt(activities, lang = 'en', special_considerations = '') {
    const activitySummary = activities.map(a => ({
        name: a.name,
        distance: (a.distance / 1000).toFixed(2), // in km
        moving_time: (a.moving_time / 60).toFixed(2), // in minutes
        average_speed: (a.average_speed * 3.6).toFixed(2), // in km/h
        start_date: a.start_date_local.split('T')[0]
    }));

    // Load translations dynamically
    const langFilePath = path.join(__dirname, `locales/${lang}.json`);
    let translations = {};
    try {
        const data = fs.readFileSync(langFilePath, 'utf8');
        translations = JSON.parse(data);
    } catch (error) {
        console.error(`Error loading language file ${langFilePath}:`, error);
        // Fallback to English if language file not found
        const enLangFilePath = path.join(__dirname, `locales/en.json`);
        const enData = fs.readFileSync(enLangFilePath, 'utf8');
        translations = JSON.parse(enData);
    }

    const summaryKey = translations.summary || "summary";
    const suggestionsKey = translations.suggestions || "suggestions";

    let prompt = `
You are an expert running coach named "iform AI". Your task is to analyze a runner's last 6 months of Strava data.
The user's preferred language is ${lang}. Please provide your entire response in this language.`;

    if (special_considerations) {
        prompt += `\n\nIMPORTANT: The user has provided the following special considerations that you MUST take into account when creating suggestions: "${special_considerations}". Your suggestions should be safe and appropriate given these considerations.`;
    }

    prompt += `

Here is the data:
${JSON.stringify(activitySummary, null, 2)}

Your response MUST be a valid JSON object, enclosed in json. The JSON object must have the following structure:
{
  "${summaryKey}": "A brief, encouraging summary of the training period (2-3 sentences).",
  "${suggestionsKey}": [
    "A first concrete, actionable suggestion for improvement. Include specific details like duration (minutes), distance (km), and repetitions. For example: 'Try incorporating interval training: 4 repetitions of 800m at a faster pace, with 2 minutes of rest in between.'",
    "A second concrete, actionable suggestion for improvement. Be specific with numbers.",
    "A third concrete, actionable suggestion for improvement. Be specific with numbers."
  ],
  "trendData": {
    "labels": ["Month 1", "Month 2", "Month 3", "Month 4", "Month 5", "Month 6"],
    "datasets": [
      {
        "label": "Average Pace (min/km)",
        "data": [5.5, 5.4, 5.6, 5.3, 5.2, 5.1]
      },
      {
        "label": "Total Distance (km)",
        "data": [50, 60, 55, 70, 75, 80]
      }
    ]
  }
}

Important instructions for the JSON content:
- For "trendData.labels", create 6 labels representing the last 6 months (e.g., ["Jan", "Feb", "Mar", "Apr", "May", "Jun"]).
- For "trendData.datasets", provide placeholder data. The actual calculations will be done on the client-side.
- Ensure all text in "${summaryKey}" and "${suggestionsKey}" is in ${lang}.
`;

    return prompt;
}


// --- SERVER START ---
app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
