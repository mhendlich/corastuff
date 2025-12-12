(function () {
    document.body.addEventListener("htmx:afterSwap", (e) => {
        const target = e.target;
        if (!target || !target.classList) return;
        if (target.hasAttribute("data-no-fade") || (target.closest && target.closest("[data-no-fade]"))) {
            return;
        }
        target.classList.add("fade-in");
    });
})();
