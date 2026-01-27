chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "KANBAN_EVENT") return;

  console.log("[KanbanBridge] SW got event", msg.payload);

  fetch("https://kanban-agent.voanhquan-hcm.workers.dev/events", {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "x-api-key": "quanva2309"
     },
    body: JSON.stringify(msg.payload)
  })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));

  return true;
});
