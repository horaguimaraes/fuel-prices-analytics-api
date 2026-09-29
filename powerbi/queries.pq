// =====================================================================================
// Power Query (M) for the Fuel Prices Analytics API
//
// How to use: in Power BI Desktop choose Get data > Blank query > Advanced editor and
// paste ONE query below per blank query. Name each query exactly as in its heading.
// Create the `ApiBase` and `ApiKey` parameters first (Home > Transform data > Manage
// parameters), so the URL lives in one place.
//
//   ApiBase   Text   http://localhost:3000        (or wherever the API is deployed)
//   ApiKey    Text   (leave empty if the API has no API_KEY set)
//
// Culture note: the CSV export always uses "." as the decimal separator. Every type
// conversion below passes "en-US" so it also works on a Brazilian-locale machine
// (where "6.75" would otherwise be read as a date or as 675).
// =====================================================================================


// ---- Query: fnGet --------------------------------------------------------------------
// Helper: GET a path from the API, adding the API key header only when one is set.
(path as text, optional query as nullable record) as binary =>
let
    Headers = if ApiKey = null or ApiKey = "" then [] else [#"x-api-key" = ApiKey],
    Options = [RelativePath = path, Headers = Headers] & (if query = null then [] else [Query = query])
in
    Web.Contents(ApiBase, Options)


// ---- Query: FactStateDaily -------------------------------------------------------------
// One row per date x state x product (avg, min, max, observations, stations).
let
    Source  = Csv.Document(fnGet("api/v1/export/state-daily", [format = "csv"]), [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),
    Headers = Table.PromoteHeaders(Source, [PromoteAllScalars = true]),
    Typed   = Table.TransformColumnTypes(
                Headers,
                {{"date", type date}, {"state", type text}, {"product", type text},
                 {"avg", type number}, {"min", type number}, {"max", type number},
                 {"observations", Int64.Type}, {"stations", Int64.Type}},
                "en-US")
in
    Typed


// ---- Query: DimStation -----------------------------------------------------------------
let
    Source  = Csv.Document(fnGet("api/v1/export/stations", [format = "csv"]), [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),
    Headers = Table.PromoteHeaders(Source, [PromoteAllScalars = true]),
    // keep CNPJ and ZIP as text: they have leading zeros that a number type would destroy
    Typed   = Table.TransformColumnTypes(Headers, {{"cnpj", type text}, {"zip", type text}}, "en-US")
in
    Typed


// ---- Query: DimState -------------------------------------------------------------------
// Distinct states with their region, derived from DimStation.
let
    Source   = Table.SelectColumns(DimStation, {"state", "region"}),
    Distinct = Table.Distinct(Source, {"state"}),
    Sorted   = Table.Sort(Distinct, {{"state", Order.Ascending}})
in
    Sorted


// ---- Query: DimProduct -----------------------------------------------------------------
let
    Json   = Json.Document(fnGet("api/v1/products")),
    Table  = Table.FromRecords(Json[data]),
    Typed  = Table.TransformColumnTypes(Table, {{"name", type text}, {"unit", type text}, {"observations", Int64.Type}, {"firstDate", type date}, {"lastDate", type date}}, "en-US")
in
    Typed


// ---- Query: DimDate --------------------------------------------------------------------
// Continuous calendar covering the loaded data (needed for time intelligence).
let
    First   = List.Min(FactStateDaily[date]),
    Last    = List.Max(FactStateDaily[date]),
    Days    = Duration.Days(Last - First) + 1,
    Dates   = List.Dates(First, Days, #duration(1, 0, 0, 0)),
    AsTable = Table.FromList(Dates, Splitter.SplitByNothing(), {"Date"}, null, ExtraValues.Error),
    Typed   = Table.TransformColumnTypes(AsTable, {{"Date", type date}}),
    Week    = Table.AddColumn(Typed, "Week start", each Date.StartOfWeek([Date], Day.Monday), type date),
    Month   = Table.AddColumn(Week, "Month", each Date.ToText([Date], "yyyy-MM", "en-US"), type text)
in
    Month


// ---- Query: fnCheapestStations ---------------------------------------------------------
// A function query: Power BI shows an "Invoke" button. Returns the N cheapest stations
// (latest price per station) for a product and, optionally, a state.
(product as text, optional state as nullable text, optional top as nullable number) as table =>
let
    Params  = [product = product, limit = Number.ToText(if top = null then 20 else top, "0", "en-US")]
                & (if state = null or state = "" then [] else [state = state]),
    Json    = Json.Document(fnGet("api/v1/stations/cheapest", Params)),
    Table   = Table.FromRecords(Json[data]),
    Typed   = Table.TransformColumnTypes(Table, {{"cnpj", type text}, {"price", type number}, {"collectedOn", type date}}, "en-US")
in
    Typed


// ---- Query: EthanolParity --------------------------------------------------------------
// Per-state ethanol/gasoline ratio (the 70% rule).
let
    Json   = Json.Document(fnGet("api/v1/insights/ethanol-parity")),
    Table  = Table.FromRecords(Json[data]),
    Typed  = Table.TransformColumnTypes(Table, {{"ethanolAvg", type number}, {"gasolineAvg", type number}, {"ratioPct", type number}}, "en-US")
in
    Typed
