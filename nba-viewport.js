'use strict';

(() => {
    if (!/\/NBATMP\.htm$/i.test(window.location.pathname)) return;

    const script = document.currentScript;
    const issueDate = script.dataset.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
        console.error('NBA viewport is missing its issue date.');
        showNotice('Unable to verify whether this page is current. The issue date is missing or invalid.');
        return;
    }

    function showNotice(message) {
        const show = () => {
            let notice = document.getElementById('viewport-date-notice');
            if (!notice) {
                notice = document.createElement('p');
                notice.id = 'viewport-date-notice';
                notice.className = 'viewport-date-notice';
                notice.setAttribute('role', 'status');
                document.querySelector('main').prepend(notice);
            }
            notice.textContent = message;
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true });
        else show();
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
                showNotice(`This page is from ${issueDate} and is not today's update. Today's picks may not be available yet; please check back later.`);
            } else if (today < issueDate) {
                showNotice(`This page is dated ${issueDate}. Please check your device's date and time.`);
            }
        } catch (error) {
            console.error('Unable to check the NBA viewport date:', error);
            showNotice(`Unable to verify whether this page is current. The page is dated ${issueDate}.`);
        }
    }

    checkDate();
    window.setInterval(checkDate, 60000);
})();
