(() => {
  const { api, esc, usageQuery } = window.dashboard;

  function statsPeriodChanged() {
    document.getElementById('statsMonthWrap').style.display = document.getElementById('statsPeriod').value === 'month' ? 'flex' : 'none';
    loadUsage();
  }

  window.statsPeriodChanged = statsPeriodChanged;
  window.loadUsage = loadUsage;
})();
