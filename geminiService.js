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

// Models to try in order — flash-lite has 3x higher free-tier rate limits
const MODELS = [
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash",
    "gemini-1.5-flash"
];

async function callGeminiWithRetry(prompt, apiKey, maxRetries = 5) {
    for (const model of MODELS) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        console.log(`Gemini Forms Helper: Trying model ${model}...`);

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
                    const waitSec = 20 * Math.pow(2, attempt - 1); // 20s, 40s, 80s, 160s, 320s
                    console.warn(`[${model}] 429 rate limit. Attempt ${attempt}/${maxRetries}. Waiting ${waitSec}s...`);
                    chrome.runtime.sendMessage({
                        action: "UPDATE_STATUS",
                        status: `Rate limited (${model}). Waiting ${waitSec}s... (${attempt}/${maxRetries})`
                    });
                    await sleep(waitSec * 1000);
                    continue;
                }

                if (response.status === 404) {
                    console.warn(`[${model}] Model not available, trying next...`);
                    break; // Try next model
                }

                if (!response.ok) {
                    const errorBody = await response.text();
                    console.error(`[${model}] API Error ${response.status}:`, errorBody);
                    throw new Error(`API Error: ${response.status} - ${response.statusText}`);
                }

                const data = await response.json();
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!text) throw new Error("No text returned from Gemini.");

                console.log(`Gemini Forms Helper: Success with model ${model}`);
                return JSON.parse(text);

            } catch (err) {
                // On last attempt of last model, throw
                if (model === MODELS[MODELS.length - 1] && attempt === maxRetries) throw err;
                // If it's not a rate limit error, try next model
                if (!err.message.includes("429") && !err.message.includes("Rate")) {
                    if (attempt === maxRetries) break; // try next model
                    throw err;
                }
            }
        }
        // If we exhausted retries for this model, try next
        console.warn(`Exhausted retries for ${model}, trying next model...`);
    }
    throw new Error("All models failed. Please wait 1-2 minutes and try again.");
}

// Global function that content.js calls
window.handleGeminiAnswers = async function (scrapedData) {
    try {
        const apiKey = await getGeminiApiKey();
        if (!apiKey) {
            chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: "Error: No API Key found." });
            return;
        }

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
