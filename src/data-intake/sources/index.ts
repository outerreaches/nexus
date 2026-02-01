import { registerDataSource } from "../registry.js";

import { cryptoSource } from "./crypto.js";
import { metalsSource } from "./metals.js";
import { rssSource } from "./rss.js";
import { stocksSource } from "./stocks.js";
import { weatherSource } from "./weather.js";

export function registerBuiltInSources(): void {
  registerDataSource(cryptoSource);
  registerDataSource(metalsSource);
  registerDataSource(rssSource);
  registerDataSource(stocksSource);
  registerDataSource(weatherSource);
}
