
let fetchedActivities = [];
let trendChart = null;

const translations = {};

// Function to set the language
async function setLanguage(lang) {
    try {
        const response = await fetch(`/api/lang/${lang}`);
        if (!response.ok) throw new Error(`Failed to fetch language file: ${response.statusText}`);
        translations[lang] = await response.json();

        document.querySelectorAll('[data-i18n]').forEach(elem => {
            const key = elem.getAttribute('data-i18n');
            if (translations[lang][key]) elem.innerHTML = translations[lang][key];
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(elem => {
            const key = elem.getAttribute('data-i18n-placeholder');
            if (translations[lang][key]) elem.placeholder = translations[lang][key];
        });
        document.documentElement.lang = lang;
        localStorage.setItem('selectedLang', lang); // Save selected language
    } catch (error) {
        console.error("Error setting language:", error);
    }
}

// Function to toggle the theme
function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    // Re-render chart with new theme colors
    if (trendChart) {
        renderTrendChart(trendChart.config.data);
    }
}

// Function to check authentication status and update UI
async function checkAuthState() {
    try {
        const response = await fetch('/api/strava/status');
        const data = await response.json();
        const authSection = document.getElementById('auth-section');
        const dataSection = document.getElementById('data-section');

        if (data.authenticated) {
            authSection.classList.add('hidden');
            dataSection.classList.remove('hidden');
        } else {
            authSection.classList.remove('hidden');
            dataSection.classList.add('hidden');
        }
    } catch (error) {
        console.error('Error checking auth state:', error);
    }
}

// Function to fetch and display activities
async function fetchActivities() {
    const activitiesList = document.getElementById('activities-list');
    const analyzeButton = document.getElementById('analyze-activities');
    activitiesList.innerHTML = `<p>${translations[document.documentElement.lang]['loading_activities'] || 'Loading activities...'}</p>`;
    analyzeButton.classList.add('hidden');

    try {
        const response = await fetch('/api/strava/activities');
        const activities = await response.json();

        if (activities.error) {
            activitiesList.innerHTML = `<p>Error: ${activities.error}</p>`;
            return;
        }

        if (activities.length === 0) {
            activitiesList.innerHTML = '<p>No activities found in the last 6 months.</p>';
            return;
        }

        fetchedActivities = activities; // Store activities
        activitiesList.innerHTML = ''; // Clear loading message

        const ul = document.createElement('ul');
        activities.forEach(activity => {
            const li = document.createElement('li');
            const distance = (activity.distance / 1000).toFixed(2);
            const date = new Date(activity.start_date).toLocaleDateString(document.documentElement.lang, {
                year: 'numeric', month: 'long', day: 'numeric'
            });
            li.innerHTML = `<strong>${activity.name}</strong><div><span>${date}</span> | <span>${distance} km</span></div>`;
            ul.appendChild(li);
        });
        activitiesList.appendChild(ul);
        analyzeButton.classList.remove('hidden'); // Show analyze button
        document.getElementById('special-considerations-section').classList.remove('hidden');

    } catch (error) {
        console.error('Failed to fetch activities:', error);
        activitiesList.innerHTML = '<p>Failed to fetch activities. Please try again.</p>';
    }
}

function calculateTrendData(activities) {
    const monthlyData = {};
    const now = new Date();

    // Initialize monthly data for the last 6 months
    for (let i = 0; i < 6; i++) {
        const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthYear = `${date.getFullYear()}-${date.getMonth() + 1}`;
        monthlyData[monthYear] = { totalDistance: 0, totalMovingTime: 0, activityCount: 0 };
    }

    activities.forEach(activity => {
        const activityDate = new Date(activity.start_date_local);
        const monthYear = `${activityDate.getFullYear()}-${activityDate.getMonth() + 1}`;

        if (monthlyData[monthYear]) {
            monthlyData[monthYear].totalDistance += activity.distance / 1000; // km
            monthlyData[monthYear].totalMovingTime += activity.moving_time / 60; // minutes
            monthlyData[monthYear].activityCount++;
        }
    });

    const labels = [];
    const averagePaceData = [];
    const totalDistanceData = [];

    for (let i = 5; i >= 0; i--) { // Iterate from oldest to newest month
        const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthYear = `${date.getFullYear()}-${date.getMonth() + 1}`;
        const monthName = date.toLocaleString(document.documentElement.lang, { month: 'short' });
        labels.push(monthName);

        const data = monthlyData[monthYear];
        if (data && data.activityCount > 0) {
            const avgPace = data.totalMovingTime / data.totalDistance; // min/km
            averagePaceData.push(avgPace.toFixed(2));
            totalDistanceData.push(data.totalDistance.toFixed(2));
        } else {
            averagePaceData.push(0);
            totalDistanceData.push(0);
        }
    }

    return {
        labels: labels,
        datasets: [
            {
                label: translations[document.documentElement.lang]['average_pace_label'] || 'Average Pace (min/km)',
                data: averagePaceData
            },
            {
                label: translations[document.documentElement.lang]['total_distance_label'] || 'Total Distance (km)',
                data: totalDistanceData
            }
        ]
    };
}

// Function to analyze activities
async function analyzeActivities() {
    const analysisResult = document.getElementById('analysis-result');
    const analysisSection = document.getElementById('analysis-section');
    const specialConsiderations = document.getElementById('special-considerations-input').value;
    analysisSection.classList.remove('hidden');
    analysisResult.innerHTML = `<p>${translations[document.documentElement.lang]['analyzing_data'] || 'iform AI is analyzing your data...'}</p>`;

    try {
        const response = await fetch('/api/analyze/activities', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
            activities: fetchedActivities,
            lang: document.documentElement.lang,
            special_considerations: specialConsiderations
        }),
        });

        const analysis = await response.json();

        if (analysis.error) {
            analysisResult.innerHTML = `<p>Error: ${analysis.error}</p>`;
            return;
        }

        analysisResult.innerHTML = ''; // Clear the loading message
        displayAnalysis(analysis);
        const trendData = calculateTrendData(fetchedActivities);
        renderTrendChart(trendData);

    } catch (error) {
        console.error('Failed to analyze activities:', error);
        analysisResult.innerHTML = '<p>Failed to get analysis. Please try again.</p>';
    }
}

function displayAnalysis(analysis) {
    const analysisResult = document.getElementById('analysis-result');
    const summaryKey = translations[document.documentElement.lang].summary;
    const suggestionsKey = translations[document.documentElement.lang].suggestions;

    const summary = analysis[summaryKey] || 'No summary available.';
    const suggestions = Array.isArray(analysis[suggestionsKey]) ? analysis[suggestionsKey] : ['No suggestions available.'];

    analysisResult.innerHTML = `
        <h4>${translations[document.documentElement.lang].summary}</h4>
        <p>${summary}</p>
        <h4>${translations[document.documentElement.lang].suggestions}</h4>
        <ul>
            ${suggestions.map(s => `<li>${s}</li>`).join('')}
        </ul>
    `;
}

function renderTrendChart(trendData) {
    const ctx = document.getElementById('trend-chart').getContext('2d');
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    const gridColor = theme === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = theme === 'dark' ? '#f0f0f0' : '#1a1a1a';

    if (trendChart) {
        trendChart.destroy();
    }

    trendChart = new Chart(ctx, {
        type: 'line',
        data: trendData,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { grid: { color: gridColor }, ticks: { color: textColor } },
                y: { grid: { color: gridColor }, ticks: { color: textColor } }
            },
            plugins: {
                legend: { labels: { color: textColor } }
            }
        }
    });
}

// --- Event Listeners ---
document.getElementById('lang-switcher').addEventListener('change', (event) => setLanguage(event.target.value));
document.getElementById('theme-switcher').addEventListener('click', toggleTheme);
document.getElementById('strava-connect').addEventListener('click', () => { window.location.href = '/api/strava/connect'; });
document.getElementById('fetch-activities').addEventListener('click', fetchActivities);
document.getElementById('analyze-activities').addEventListener('click', analyzeActivities);
document.getElementById('recalculate-analysis').addEventListener('click', analyzeActivities);

// --- Initial Load ---
document.addEventListener('DOMContentLoaded', () => {
    const savedLang = localStorage.getItem('selectedLang');
    const initialLang = savedLang || navigator.language.split('-')[0] || 'no';
    const langSwitcher = document.getElementById('lang-switcher');
    if ([...langSwitcher.options].some(opt => opt.value === initialLang)) {
        langSwitcher.value = initialLang;
    }
    setLanguage(langSwitcher.value);

    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
        document.documentElement.setAttribute('data-theme', 'light');
    } else {
        document.documentElement.setAttribute('data-theme', 'dark');
    }

    checkAuthState();
    fetchGithubUrl();
});

async function fetchGithubUrl() {
    try {
        const response = await fetch('/api/github_url');
        const data = await response.json();
        if (data.url) {
            document.getElementById('github-link').href = data.url;
        }
    } catch (error) {
        console.error('Error fetching GitHub URL:', error);
    }
}
