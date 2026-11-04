for (const btn of document.querySelectorAll(".copy-btn")) {
  btn.addEventListener("click", async () => {
    const text = btn.dataset.copy;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "已复制";
      setTimeout(() => {
        btn.textContent = "复制";
      }, 1400);
    } catch {}
  });
}
