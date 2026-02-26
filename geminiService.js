// geminiService.js - API integration

async function getGeminiApiKey() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['geminiApiKey'], (result) => {
            resolve(result.geminiApiKey);
        });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function callGeminiWithRetry(prompt, apiKey, maxRetries = 5) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.1,
                        responseMimeType: "application/json"
                    }
                })
            });

            if (response.status === 429) {
                // Exponential backoff: 15s, 30s, 60s, 120s, 240s
                const waitSec = 15 * Math.pow(2, attempt - 1);
                console.warn(`Gemini 429 rate limit. Attempt ${attempt}/${maxRetries}. Waiting ${waitSec}s...`);
                chrome.runtime.sendMessage({
                    action: "UPDATE_STATUS",
                    status: `Rate limited. Waiting ${waitSec}s... (attempt ${attempt}/${maxRetries})`
                });
                await sleep(waitSec * 1000);
                continue;
            }

            if (!response.ok) {
                throw new Error(`API Error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error("No text returned from Gemini.");

            return JSON.parse(text);

        } catch (err) {
            if (attempt === maxRetries) throw err;
            if (!err.message.includes("429")) throw err;
        }
    }
    throw new Error("Failed after all retries due to rate limiting. Please wait a minute and try again.");
}

// Global function that content.js calls
window.handleGeminiAnswers = async function (scrapedData) {
    try {
        const apiKey = await getGeminiApiKey();
        if (!apiKey) {
            chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: "Error: No API Key found." });
            return;
        }

        // Send ALL questions in a single call to minimize API requests
        chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: `Sending ${scrapedData.length} questions to Gemini...` });

        let promptText = "You are an expert quiz/test answering assistant. I will provide questions with IDs and options.\n\n" +
            "Return ONLY a JSON array. Each element: {\"id\": <int>, \"answer\": [\"<exact option text>\"]}\n" +
            "Match option text EXACTLY as provided.\n\n";

        scrapedData.forEach(q => {
            promptText += `ID:${q.id} | Type:${q.type} | Q: ${q.question} | Options: ${JSON.stringify(q.options)}\n`;
        });

        console.log("Gemini Forms Helper: Sending prompt...", promptText);

        const answersJson = await callGeminiWithRetry(promptText, apiKey);
        console.log("Gemini Forms Helper: Received answers:", answersJson);

        chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: "Applying answers..." });

        if (typeof window.applyAnswersToForm === 'function') {
            window.applyAnswersToForm(scrapedData, answersJson);
            chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: "Done ✅" });
        } else {
            console.warn("applyAnswersToForm not found.");
            chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: "Error: Could not apply answers." });
        }

    } catch (err) {
        console.error("Gemini Forms Helper API Error:", err);
        chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: `Error: ${err.message}` });
    }
};
