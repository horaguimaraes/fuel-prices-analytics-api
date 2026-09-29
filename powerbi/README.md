# Power BI report

The API is the data source; Power BI is the presentation layer. This folder has everything needed to rebuild the report in a few minutes:

| File | Purpose |
|:--|:--|
| [`queries.pq`](queries.pq) | Power Query (M) queries: 2 facts/dimensions from the CSV exports, plus product, date, insight and a "cheapest stations" function |
| [`measures.dax`](measures.dax) | DAX measures: weighted average price, vs national, week-over-week, moving average, rankings |

> **Status:** the queries and measures are written against the API's real response shapes, and the API side (CSV headers, JSON fields) is covered by tests. The `.pbix` itself is not committed, and the M/DAX has not been exercised in Power BI Desktop in this repository's CI, so treat it as a tested-on-the-API-side starting point.

## Setup

1. Start the API and load data (see the main [README](../README.md)).
2. In Power BI Desktop create two parameters: `ApiBase` (e.g. `http://localhost:3000`) and `ApiKey` (empty if the API has no key).
3. Paste each query from `queries.pq` into a blank query, named as in its heading. Start with `fnGet`. Choose **Anonymous** access when prompted.
4. Build the relationships below and paste the measures from `measures.dax`.

### Model

```
DimDate    (Date)  1 ──< FactStateDaily (date)
DimState   (state) 1 ──< FactStateDaily (state)
DimProduct (name)  1 ──< FactStateDaily (product)
DimState   (state) 1 ──< DimStation     (state)
```

`FactStateDaily` stores daily aggregates, not raw rows: about 4,000 rows for a month of all products and states, so refresh is instant and the report stays small.

## Suggested pages

**1. Overview**
- KPI cards: *Avg Price*, *Change vs Prev Week %*, *Cheapest State*, *Latest Date*
- Line chart: *Avg Price* and *Avg Price 7d Moving* by `DimDate[Date]`
- Filled map or bar chart: *Avg Price* by `DimState[state]`, colored by *Vs National %*
- Slicers: product (single select), date range, region

**2. State ranking**
- Bar chart sorted by *Avg Price* ascending, with *Rank Cheapest State* as a tooltip
- Table: state, *Avg Price*, *Min Price*, *Max Price*, *Vs National %*, *Observations*

**3. Ethanol or gasoline?**
- Bar chart of `EthanolParity[ratioPct]` by state with a constant line at 70
- Card: *States Where Ethanol Wins*
- Note that states with few stations are noisy: `ethanolStations` is in the table so you can filter

**4. Cheapest stations** (optional)
- Invoke `fnCheapestStations` with a product and state and show it as a table

## Publishing to the Power BI Service

`localhost` is not reachable from the cloud service. Either deploy the API somewhere public (the repository has a `Dockerfile`), or install an [on-premises data gateway](https://learn.microsoft.com/power-bi/connect-data/service-gateway-onprem) next to it. If you expose the API, set `API_KEY` and pass it via the `ApiKey` parameter.
