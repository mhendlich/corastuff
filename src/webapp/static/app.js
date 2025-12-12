(function () {
    document.body.addEventListener("htmx:afterSwap", (e) => {
        const target = e.target;
        if (target && target.classList) {
            target.classList.add("fade-in");
        }
    });
})();
