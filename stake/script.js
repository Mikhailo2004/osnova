document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('loaded');

  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const light = !document.body.classList.contains('light');
      document.body.classList.toggle('light', light);
      toggleBtn.textContent = light ? 'Темная тема' : 'Светлая тема';
    });
  }

  const cryptoIds = {
    usdc: 'usd-coin',
    usdt: 'tether',
    doge: 'dogecoin',
    ltc: 'litecoin',
    eth: 'ethereum',
    bnb: 'binancecoin'
  };

  function updatePrices() {
    const ids = Object.values(cryptoIds).join(',');
    fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`)
      .then(r => r.json())
      .then(data => {
        for (const [short, id] of Object.entries(cryptoIds)) {
          const price = data[id]?.usd;
          if (price) {
            const el = document.querySelector(`#${short} .price`);
            if (el) el.textContent = `$${price}`;
          }
        }
      }).catch(() => {});
  }

  function updateClocks() {
    const now = new Date();
    const fmt = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
    const zones = {
      'clock-sg': 'Asia/Singapore',
      'clock-ny': 'America/New_York',
      'clock-cn': 'Asia/Shanghai',
      'clock-af': 'Africa/Johannesburg',
      'clock-ru': 'Europe/Moscow',
      'time-kyiv': 'Europe/Kyiv',
      'time-london': 'Europe/London',
      'time-newyork': 'America/New_York'
    };
    for (const [id, zone] of Object.entries(zones)) {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = now.toLocaleTimeString('en-US', { ...fmt, timeZone: zone });
      }
    }
  }

  const stakeBtn = document.getElementById('stake-button');
  if (stakeBtn) {
    stakeBtn.addEventListener('click', () => {
      fetch('track.php?event=stake');
    });
  }

  updatePrices();
  updateClocks();
  setInterval(updatePrices, 60000);
  setInterval(updateClocks, 1000);
});
