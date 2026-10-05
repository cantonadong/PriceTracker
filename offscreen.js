chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "PARSE_OFFSCREEN") return;
  try {
    const doc = new DOMParser().parseFromString(message.html, "text/html");
    sendResponse(readProductPrice(doc, message.selector, message.url));
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
});
