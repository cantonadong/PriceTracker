// Shared by extension pages and the background module.
globalThis.WatchState = Object.freeze({
  hasPrice(watch) {
    const value = watch?.currentPrice;
    return (typeof value === "number" || typeof value === "string") && String(value).trim() !== "" && Number.isFinite(Number(value));
  },
  isTriggered(watch) {
    return this.hasPrice(watch) && Number.isFinite(Number(watch.targetPrice)) && Number(watch.currentPrice) <= Number(watch.targetPrice);
  }
});
