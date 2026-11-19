'use strict';

(() => {
    if (!/\/NBATMP\.htm$/i.test(window.location.pathname)) return;

    const script = document.currentScript;
    const issueDate = script.dataset.date;
    const fallback = script.dataset.fallback;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate) || !fallback) {
        console.error('NBA viewport is missing its issue date or fallback URL.');
        return;
    }

    function checkDate() {
        try {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
            }).formatToParts(new Date());
            const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
            const today = `${date.year}-${date.month}-${date.day}`;
            const nextDay = new Date(Date.parse(`${issueDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
            if (today > nextDay || (today === nextDay && `${date.hour}:${date.minute}` >= '04:30')) {
                window.location.replace(fallback);
            }
        } catch (error) {
            console.error('Unable to check the NBA viewport date:', error);
            window.location.replace(fallback);
        }
    }

    checkDate();
    window.setInterval(checkDate, 60000);
})();
