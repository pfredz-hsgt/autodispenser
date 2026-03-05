const { chromium } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

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
    console.log("--- PhIS Auto Dispenser (OPD) ---");
    console.log(`Running from: ${executeDir}`);

    // 1. READ CONFIG
    const configPath = path.join(executeDir, 'config.json');
    let CONFIG;
    try {
        const rawData = fs.readFileSync(configPath, 'utf8');
        CONFIG = JSON.parse(rawData);
        console.log(`✅ Loaded user: ${CONFIG.username}`);
    } catch (e) {
        console.error(`❌ Error: Config not found at ${configPath}`);
        await waitForUser("Exiting...");
        return;
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
            executablePath: executablePath
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

        console.log("✅ Ready. Entering Loop...");

        // 4. START THE LOOP
        let patientsProcessed = 0;
        let patientIndex = 0;

        const STAGE_LIST = 'div[_wnd="dispensingNormalListWindow"]';
        const STAGE_DIALOG = 'div[_wnd="dispensingNormalDialogWindow"]';

        // --- FIX 2: Check connection at start of loop ---
        while (browser.isConnected()) {
            try {
                if (page.isClosed()) break;
                await page.waitForTimeout(2000);

                // --- CHECKPOINT: ARE WE ON THE MAIN LIST? ---
                if (await page.isVisible(STAGE_LIST)) {
                    const searchBtnSelector = 'button[_comp="button_Search"]';
                    const targetRowSelector = '.z-listbox-body tr.z-listitem:has-text("HSGT")';
                    const closeBtn = 'button[_comp="btnClose"]';

                    console.log(`\n--- Patient Count #${patientsProcessed + 1} (Row: ${patientIndex + 1}) ---`);

                    // A. FIND PATIENT
                    try {
                        await page.waitForSelector(targetRowSelector, { state: 'visible', timeout: 10000 });
                    } catch (e) {
                        console.log("🏁 Dispensing Cleared! Clicking Search Button...");
                        await page.click(searchBtnSelector);
                        patientIndex = 0;
                        await page.waitForTimeout(5000);
                        continue;
                    }

                    const patients = page.locator(targetRowSelector);
                    const count = await patients.count();

                    if (patientIndex >= count) {
                        console.log("⚠️ Reached end of list. Refreshing...");
                        await page.click(searchBtnSelector);
                        patientIndex = 0;
                        continue;
                    }

                    console.log(`Opening patient at row ${patientIndex + 1}...`);
                    try {
                        // Reduced timeout to 5s so it doesn't hang for 30s if blocked
                        await patients.nth(patientIndex).dblclick({ timeout: 5000 });
                    } catch (clickErr) {
                        if (clickErr.message.includes('intercepts pointer events') || clickErr.message.includes('Timeout')) {
                            console.log("⚠️ UI blocked by a popup. Attempting to clear it...");

                            // Check for the specific system error label you provided
                            const errLabelSelector = 'span[_ctrl="ErrCtrl"]';
                            const genericOkBtn = 'button.z-button:has-text("OK"), button.z-button:has-text("Yes")';

                            if (await page.isVisible(genericOkBtn)) {
                                const errText = await page.locator(errLabelSelector).innerText().catch(() => "Unknown System Error");
                                console.log(`📢 System Alert: ${errText.trim()}`);

                                console.log("🖱️ Clicking OK/Yes to dismiss...");
                                // Click the first visible OK/Yes button
                                await page.locator(genericOkBtn).first().click();
                                await page.waitForTimeout(1500); // Give the modal a second to fade out

                                // Reset index and restart loop cycle to try again
                                patientIndex = 0;
                                continue;
                            }
                        }
                        // If it's a different error, throw it to the main loop error handler
                        throw clickErr;
                    }

                    // --- INFO POPUP HANDLER ---
                    try {
                        const infoOkBtn = 'div.z-messagebox-window button.z-messagebox-button:has-text("OK")';
                        const hasInfoPopup = await page.waitForSelector(infoOkBtn, { state: 'visible', timeout: 3000 }).catch(() => null);

                        if (hasInfoPopup) {
                            console.log(`ℹ️ Info Popup Detected. Clicking OK...`);
                            await hasInfoPopup.click();
                            await page.waitForTimeout(500);
                        }
                    } catch (e) { }

                    // --- CHECKPOINT: INSIDE PATIENT DIALOG? ---
                    if (await page.waitForSelector(STAGE_DIALOG, { state: 'visible', timeout: 15000 }).catch(() => false)) {


                        try {
                            const nameSelector = 'span[_comp="label_PateintName"]';
                            await page.waitForSelector(nameSelector, { state: 'visible', timeout: 10000 });
                            const patName = await page.innerText(nameSelector);
                            console.log(`Processing: ${patName.trim()}`);
                        } catch (scrapeErr) {
                            console.log("⚠️ Could not read patient name banner.");
                        }


                        // B. CHECK "PATIENT ARRIVED"
                        const checkboxInput = 'span[_comp="patientArrived"] input[type="checkbox"]';
                        try {
                            const isChecked = await page.isChecked(checkboxInput);
                            if (!isChecked) {
                                console.log('☑️ Ticking "Patient Arrived"...');
                                await page.check(checkboxInput, { force: true });
                                await page.waitForTimeout(500);
                                if (!(await page.isChecked(checkboxInput))) {
                                    await page.$eval(checkboxInput, (el) => {
                                        el.checked = true;
                                        el.dispatchEvent(new Event('change', { bubbles: true }));
                                    });
                                }
                            }
                        } catch (err) {
                            console.log("⚠️ Checkbox skipped.");
                        }

                        // C. DISPENSE
                        const dispenseBtnSelector = 'button[_comp="btnDispense"]';
                        await page.waitForSelector(dispenseBtnSelector, { state: 'visible', timeout: 10000 });
                        await page.click(dispenseBtnSelector);

                        // D. HANDLE POPUP
                        const yesSelector = 'button.z-messagebox-button:has-text("Yes")';
                        const okSelector = 'button.z-messagebox-button:has-text("OK")';
                        const labelSelector = '.z-messagebox span.z-label';

                        try {
                            const foundButton = await page.waitForSelector(`${yesSelector}, ${okSelector}`, { state: 'visible', timeout: 10000 });
                            const btnText = await foundButton.innerText();
                            const alertText = await page.locator(labelSelector).innerText().catch(() => "N/A");

                            console.log(`📢 Message: ${alertText.trim()}`);

                            if (btnText.includes("OK")) {
                                console.log("❌ Dispense Error. Closing...");
                                await foundButton.click();
                                await closePatientWindow(page);
                                patientIndex++;
                            } else {
                                console.log("✅ Success! Confirming...");
                                await foundButton.click();
                                await page.waitForSelector(STAGE_DIALOG, { state: 'hidden', timeout: 15000 }).catch(() => { });
                                patientsProcessed++;
                                patientIndex = 0;
                            }
                        } catch (popupErr) {
                            console.log("⚠️ No popup. Checking window...");
                            if (await page.isVisible(STAGE_DIALOG)) {
                                await closePatientWindow(page);
                                patientIndex++;
                            }
                        }
                    }
                }
            } catch (loopError) {
                // --- FIX 3: THE RAPID ERROR STOPPER ---
                const msg = loopError.message;
                if (msg.includes('closed') || msg.includes('not open') || msg.includes('Navigation failed')) {
                    console.log("🛑 Browser closed detected. Stopping script.");
                    break; // EXIT THE LOOP IMMEDIATELY
                }

                console.error(`❌ Loop Error: ${loopError.message}`);

                // Only try to recover if browser is still alive
                if (browser.isConnected() && !page.isClosed()) {
                    await closePatientWindow(page).catch(() => { });
                    patientIndex++;
                } else {
                    break;
                }
            }
        }

    } catch (criticalError) {
        console.error("🔥 CRITICAL FAILURE:", criticalError.message);
    }
})();

async function closePatientWindow(page) {
    const closeBtn = 'button[_comp="btnClose"]';
    try {
        if (!page.isClosed() && await page.isVisible(closeBtn)) {
            console.log("Closing patient record...");
            await page.click(closeBtn);
            await page.waitForSelector('div[_wnd="dispensingNormalDialogWindow"]', { state: 'hidden', timeout: 5000 });
        }
    } catch (e) {
        // Ignore errors during closing
    }
}