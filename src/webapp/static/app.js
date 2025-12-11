(function () {
    const root = document.documentElement;
    const storageKey = "corastuff.sidebar.collapsed";

    function setCollapsed(collapsed) {
        root.dataset.sidebarCollapsed = collapsed ? "true" : "false";
        try {
            localStorage.setItem(storageKey, collapsed ? "1" : "0");
        } catch {}
    }

    const initialCollapsed = (() => {
        try {
            return localStorage.getItem(storageKey) === "1";
        } catch {
            return false;
        }
    })();

    setCollapsed(initialCollapsed);

    const toggle = document.getElementById("sidebar-toggle");
    toggle?.addEventListener("click", () => {
        setCollapsed(root.dataset.sidebarCollapsed !== "true");
    });

    window.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
            e.preventDefault();
            setCollapsed(root.dataset.sidebarCollapsed !== "true");
        }
    });

    document.body.addEventListener("htmx:afterSwap", (e) => {
        const target = e.target;
        if (target && target.classList) {
            target.classList.add("fade-in");
        }
    });
})();

