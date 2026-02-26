document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const answerBtn = document.getElementById('answerBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusText = document.getElementById('statusText');
  const statusDot = document.getElementById('statusDot');

  // Load saved API key
  chrome.storage.local.get(['geminiApiKey'], (result) => {
    if (result.geminiApiKey) {
      apiKeyInput.value = result.geminiApiKey;
    }
  });

  // Save API key when changed
  apiKeyInput.addEventListener('input', () => {
    chrome.storage.local.set({ geminiApiKey: apiKeyInput.value });
  });

  function updateStatus(message) {
    statusText.textContent = message;

    // Update dot state
    statusDot.className = 'status-dot';
    if (message.toLowerCase().includes('error') || message.toLowerCase().includes('fail')) {
      statusDot.classList.add('error');
    } else if (message.includes('✅') || message.toLowerCase() === 'ready to solve') {
      statusDot.classList.add(message.toLowerCase() === 'ready to solve' ? 'idle' : 'done');
    } else if (message.toLowerCase() !== 'ready to solve' && message.toLowerCase() !== 'idle') {
      statusDot.classList.add('working');
    } else {
      statusDot.classList.add('idle');
    }
  }

  // Handle "Answer Form" button click
  answerBtn.addEventListener('click', async () => {
    if (!apiKeyInput.value) {
      updateStatus("Error: API Key is required.");
      return;
    }

    updateStatus("Scraping form...");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab.url && tab.url.includes("docs.google.com/forms")) {
      chrome.tabs.sendMessage(tab.id, { action: "ANSWER_FORM" }, (response) => {
        if (chrome.runtime.lastError) {
          updateStatus("Error: Can't connect to page. Reload the form.");
          return;
        }
      });
    } else {
      updateStatus("Error: Not a Google Form.");
    }
  });

  // Handle "Clear Selections" button click
  clearBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.url && tab.url.includes("docs.google.com/forms")) {
      chrome.tabs.sendMessage(tab.id, { action: "CLEAR_SELECTIONS" });
      updateStatus("Ready to solve");
    }
  });

  // Listen for status updates from content script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "UPDATE_STATUS") {
      updateStatus(request.status);
    }
  });
});
