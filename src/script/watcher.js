const { chromium } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const executeDir = __dirname;

function waitForUser(message) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        process.stdout.write('\x07');
        rl.question(`\n🛑 ${message}\n👉 Press ENTER to resume...`, () => {
            rl.close();
            resolve();
        });
    });
}

(async () => {
    console.log("--- PhIS Dispensing Monitor (OPD) ---");

    // 1. READ CONFIG
    let CONFIG = {
        username: 'system',
        password: 'phis12345',
        location: 'Outpatient Pharmacy Counter',
        threshold: 20
    };
    const configPath = path.join(executeDir, 'config.json');
    try {
        if (fs.existsSync(configPath)) {
            const configData = fs.readFileSync(configPath, 'utf8');
            // Remove trailing commas before parsing if any
            const cleanData = configData.replace(/,\s*}/g, '}');
            CONFIG = { ...CONFIG, ...JSON.parse(cleanData) };
        }
    } catch (err) {
        console.error("Error reading config:", err.message);
    }

    // 2. LOCATE BROWSER
    const browserBaseDir = path.join(executeDir, 'browsers');
    let executablePath = "";

    try {
        if (!fs.existsSync(browserBaseDir)) throw new Error("'browsers' folder is missing!");
        const dirs = fs.readdirSync(browserBaseDir);
        const chromiumDir = dirs.find(d => d.includes('chromium'));
        if (!chromiumDir) throw new Error("No 'chromium-xxxx' folder found inside 'browsers'");

        const possiblePath64 = path.join(browserBaseDir, chromiumDir, 'chrome-win64', 'chrome.exe');
        const possiblePath32 = path.join(browserBaseDir, chromiumDir, 'chrome-win', 'chrome.exe');

        if (fs.existsSync(possiblePath64)) executablePath = possiblePath64;
        else if (fs.existsSync(possiblePath32)) executablePath = possiblePath32;
        else throw new Error(`Found ${chromiumDir}, but could not find chrome.exe.`);

        console.log(`✅ Browser detected at: ${executablePath}`);

    } catch (e) {
        console.error(`❌ Browser Error: ${e.message}`);
        await waitForUser("Exiting...");
        return;
    }

    // 3. LAUNCH BROWSER & LOGIN
    try {
        const browser = await chromium.launch({
            headless: true,
            executablePath: executablePath,
            args: [
                '--autoplay-policy=no-user-gesture-required', // 🔊 Allows audio to play without clicking
                '--disable-features=AudioServiceOutOfProcess' // Ensures audio connects to your system speakers
            ]
        });

        // --- FIX 1: Detect if browser closes unexpectedly ---
        browser.on('disconnected', () => {
            console.log("\n🛑 Browser was closed manually. Exiting script...");
            process.exit(0);
        });

        const page = await browser.newPage();

        console.log("Logging in...");
        await page.goto('http://10.77.232.70:8080/iphis/login.zul');
        await page.fill('input[name="j_username"]', CONFIG.username);
        await page.fill('input[name="j_password"]', CONFIG.password);
        await page.click('input[name="combo_loc"]', { force: true });
        await page.waitForTimeout(2000);
        await page.click(`.z-comboitem-text:has-text("${CONFIG.location}")`);
        await page.waitForTimeout(2000);
        await page.click('#btnLogin');

        console.log("✅ Logged in. Navigating...");

        // Navigation
        await page.waitForSelector('span.z-treecell-text:has-text("Pharmacy Transaction")');
        await page.dblclick('span.z-treecell-text:has-text("Pharmacy Transaction")');
        await page.waitForSelector('span.z-treecell-text:has-text("Dispensing")');
        await page.dblclick('span.z-treecell-text:has-text("Dispensing")');
        await page.waitForSelector('span.z-treecell-text:has-text("Normal")');
        await page.dblclick('span.z-treecell-text:has-text("Normal")');
        await page.waitForSelector('span.z-treecell-text:has-text("Outpatient")');
        await page.dblclick('span.z-treecell-text:has-text("Outpatient")');

        await page.locator('span.z-treecell-text')
            .filter({ has: page.locator('img') })
            .filter({ hasText: /^[\s\u00a0]*Dispensing[\s\u00a0]*$/ })
            .click();

        console.log("✅ Ready. Starting Dispensing Monitor...");

        // 4. START THE LOOP

        while (browser.isConnected()) {
            const threshold = CONFIG.threshold ? Number(CONFIG.threshold) : 30;
            await startPrescriptionMonitor(page, threshold, 5); //(page, <threshold>, <alertInterval in Sec>)
        }

    } catch (criticalError) {
        console.error("🔥 Unknown Error: Please restart the script.", criticalError.message);
    }
})();

/**
 * Helper function to signal the Dashboard to play the alert sound natively
 */
async function playAlertSound(page, filePath) {
    try {
        console.log("🔊 [SYSTEM_ALERT_PLAY_SOUND]");
    } catch (err) {
        console.log(`⚠️ Play function crashed: ${err.message}`);
    }
}

/**
 * The Main Monitoring Loop (With Dynamic Polling)
 */
async function startPrescriptionMonitor(page, threshold = 10, alertIntervalSec = 5) {
    console.log(`\n👁️ Monitoring queue > ${threshold}`);

    let lastRefreshTime = Date.now();
    let lastKnownCount = -1; // Memory to track queue changes

    // DYNAMIC REFRESH TIMERS
    const normalRefreshMs = 1 * 30 * 1000; // 30 seconds (Normal mode)
    const alertRefreshMs = 1 * 10 * 1000;  // 10 seconds (High alert mode)
    let currentRefreshMs = normalRefreshMs;

    const soundFile = path.join(__dirname, 'alert.wav');
    const STAGE_LIST = 'div[_comp="dispensingNormalListWindow"]';

    // Force the monitor to click search immediately on startup
    let needsInitialClick = true;

    while (page.context().browser().isConnected() && !page.isClosed()) {
        try {
            const pagingSelector = 'div[_comp="dispensingNormalListWindow"] .z-paging-info span';
            const searchBtnSelector = 'button[_comp="button_Search"]';
            let justRefreshed = false;

            // 1. CHECK TIMER OR INITIAL START
            if (needsInitialClick || (Date.now() - lastRefreshTime > currentRefreshMs)) {
                console.log(`🔄 Refreshing every ${currentRefreshMs / 1000} sec...`);

                if (await page.isVisible(STAGE_LIST) && await page.isVisible(searchBtnSelector)) {
                    await page.click(searchBtnSelector);
                    try {
                        await page.waitForSelector('.z-loading-indicator', { state: 'hidden', timeout: 15000 });
                        await page.waitForTimeout(2000);
                    } catch (waitErr) {
                        await page.waitForTimeout(8000);
                    }
                }

                lastRefreshTime = Date.now();
                justRefreshed = true;
                needsInitialClick = false;
            }

            // 2. EXTRA WAIT FOR LOADING (Just to be safe)
            try {
                await page.waitForSelector('.z-loading-indicator', { state: 'hidden', timeout: 5000 });
            } catch (waitErr) {
            }

            // 3. EXTRACT AND CHECK THE PRESCRIPTION COUNT
            try {
                await page.waitForSelector(pagingSelector, { state: 'visible', timeout: 5000 });
                const infoText = await page.innerText(pagingSelector);
                const allNumbers = infoText.match(/\d+/g);

                if (allNumbers && allNumbers.length > 0) {
                    const totalCount = parseInt(allNumbers[allNumbers.length - 1], 10);

                    // Print to console ONLY if the number changed OR if we just hit the 30s refresh!
                    if (totalCount !== lastKnownCount || justRefreshed) {
                        if (totalCount === 0) {
                            console.log(`✅ Current queue: 0`);
                        } else {
                            console.log(`Current queue: ${totalCount} patients`);
                        }
                        lastKnownCount = totalCount;
                    }

                    // --- DYNAMIC SPEED SHIFTING ---
                    if (totalCount > threshold) {
                        currentRefreshMs = alertRefreshMs;
                        console.log(`🚨 ALERT! ${totalCount} patient. (Max: ${threshold} patient)`);
                        await playAlertSound(page, soundFile);

                        await page.waitForTimeout(alertIntervalSec * 1000);
                        continue; // Skip the default 5s wait below to respect the alert interval
                    } else {
                        currentRefreshMs = normalRefreshMs;
                    }
                }
            } catch (pagingErr) {
                // If it fails to find the paging text, the queue might be exactly 0
                if (justRefreshed) {
                    //    console.log(`✅ Current queue: 0`);
                    lastKnownCount = 0;
                }
            }

            // 4. Wait a short time before the next micro-check
            await page.waitForTimeout(5000);

        } catch (e) {
            console.error("Monitor loop error:", e);
            await page.waitForTimeout(10000);
        }
    }
}