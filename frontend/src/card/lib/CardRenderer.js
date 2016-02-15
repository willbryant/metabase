/*global google*/

import _ from "underscore";
import crossfilter from "crossfilter";
import d3 from "d3";
import dc from "dc";

import GeoHeatmapChartRenderer from "./GeoHeatmapChartRenderer";

import {
    getAvailableCanvasWidth,
    getAvailableCanvasHeight,
    computeSplit,
    getFriendlyName,
    getCardColors
} from "./utils";

import { computeTimeseriesTicksInterval } from "./timeseries";
import { determineSeriesIndexFromElement } from "./tooltip";

import { formatValue } from "metabase/lib/formatting";

// agument d3 with a simple quarters range implementation
d3.time.quarters = (start, stop, step) => d3.time.months(start, stop, 3);

const MIN_PIXELS_PER_TICK = { x: 100, y: 30 };
const BAR_PADDING_RATIO = 0.2;
const DEFAULT_INTERPOLATION = "linear";

// investigate the response from a dataset query and determine if the dimension is a timeseries
function dimensionIsTimeseries(result) {
    let hasDateField = result.cols && result.cols.length > 0 && result.cols[0].base_type === "DateField";

    let isDateFirstVal = false;
    if (result.rows && result.rows.length > 0 && result.rows[0].length > 0 &&
            !(!isNaN(parseFloat(result.rows[0][0])) && isFinite(result.rows[0][0]))) {
        isDateFirstVal = ( (new Date(result.rows[0][0]) !== "Invalid Date" && !isNaN(new Date(result.rows[0][0])) ));
    }

    return (hasDateField || isDateFirstVal);
}

function adjustTicksIfNeeded(axis, axisSize, minPixelsPerTick) {
    let numTicks = axis.ticks();
    // d3.js is dumb and sometimes numTicks is a number like 10 and other times it is an Array like [10]
    // if it's an array then convert to a num
    numTicks = numTicks.length != null ? numTicks[0] : numTicks;

    if ((axisSize / numTicks) < minPixelsPerTick) {
        axis.ticks(Math.round(axisSize / minPixelsPerTick));
    }
}

function getDcjsChartType(cardType) {
    switch (cardType) {
        case "pie":  return "pieChart";
        case "line": return "lineChart";
        case "area": return "lineChart";
        case "bar":  return "barChart";
        default:     return "barChart";
    }
}

function initializeChart(card, element, chartType = getDcjsChartType(card.display)) {
    // create the chart
    let chart = dc[chartType](element);

    // set width and height
    chart = applyChartBoundary(chart, element);

    // specify legend
    chart = applyChartLegend(chart, card);

    // disable animations
    chart.transitionDuration(0);

    return chart;
}

function applyChartBoundary(chart, element) {
    return chart
        .width(getAvailableCanvasWidth(element))
        .height(getAvailableCanvasHeight(element));
}

function applyChartLegend(chart, card) {
    // ENABLE LEGEND IF SPECIFIED IN VISUALIZATION SETTINGS
    // I'm sure it made sense to somebody at some point to make this setting live in two different places depending on the type of chart.
    let settings = card.visualization_settings;
    let legendEnabled = false;

    if (card.display === "pie" && settings.pie) {
        legendEnabled = settings.pie.legend_enabled;
    } else if (settings.chart) {
        legendEnabled = settings.chart.legend_enabled;
    }

    if (legendEnabled) {
        return chart.legend(dc.legend());
    } else {
        return chart;
    }
}

function applyChartTimeseriesXAxis(chart, card, cols, xValues) {
    // setup an x-axis where the dimension is a timeseries
    let settings = card.visualization_settings;

    // set the axis label
    if (settings.xAxis.labels_enabled) {
        chart.xAxisLabel((settings.xAxis.title_text || null) || cols[0].display_name);
        chart.renderVerticalGridLines(settings.xAxis.gridLine_enabled);

        if (cols[0] && cols[0].unit) {
            chart.xAxis().tickFormat(d => formatValue(d, cols[0]));
        } else {
            chart.xAxis().tickFormat(d3.time.format.multi([
                [".%L",    (d) => d.getMilliseconds()],
                [":%S",    (d) => d.getSeconds()],
                ["%I:%M",  (d) => d.getMinutes()],
                ["%I %p",  (d) => d.getHours()],
                ["%a %d",  (d) => d.getDay() && d.getDate() != 1],
                ["%b %d",  (d) => d.getDate() != 1],
                ["%B", (d) => d.getMonth()], // default "%B"
                ["%Y", () => true] // default "%Y"
            ]));
        }

        // Compute a sane interval to display based on the data granularity, domain, and chart width
        let interval = computeTimeseriesTicksInterval(xValues, cols[0], chart.width(), MIN_PIXELS_PER_TICK.x);
        chart.xAxis().ticks(d3.time[interval.interval], interval.count);
    } else {
        chart.xAxis().ticks(0);
    }

    // calculate the x-axis domain
    let xDomain = d3.extent(xValues);
    chart.x(d3.time.scale().domain(xDomain));

    // prevents skinny time series bar charts by using xUnits that match the provided column unit, if possible
    if (cols[0] && cols[0].unit && d3.time[cols[0].unit + "s"]) {
        chart.xUnits(d3.time[cols[0].unit + "s"]);
    }
}

function applyChartOrdinalXAxis(chart, card, cols, xValues) {
    let settings = card.visualization_settings;
    if (settings.xAxis.labels_enabled) {
        chart.xAxisLabel(settings.xAxis.title_text || cols[0].display_name);
        chart.renderVerticalGridLines(settings.xAxis.gridLine_enabled);
        chart.xAxis().ticks(xValues.length);
        adjustTicksIfNeeded(chart.xAxis(), chart.width(), MIN_PIXELS_PER_TICK.x);

        // unfortunately with ordinal axis you can't rely on xAxis.ticks(num) to control the display of labels
        // so instead if we want to display fewer ticks than our full set we need to calculate visibleTicks()
        let numTicks = chart.xAxis().ticks();
        if (Array.isArray(numTicks)) {
            numTicks = numTicks[0];
        }
        if (numTicks < xValues.length) {
            let keyInterval = Math.round(xValues.length / numTicks);
            let visibleKeys = xValues.filter((v, i) => i % keyInterval === 0);
            chart.xAxis().tickValues(visibleKeys);
        }
        chart.xAxis().tickFormat(d => formatValue(d, cols[0]));
    } else {
        chart.xAxis().ticks(0);
        chart.xAxis().tickFormat('');
    }

    chart.x(d3.scale.ordinal().domain(xValues))
        .xUnits(dc.units.ordinal);
}

function applyChartYAxis(chart, card, cols) {
    let settings = card.visualization_settings;
    if (settings.yAxis.labels_enabled) {
        chart.yAxisLabel(settings.yAxis.title_text || getFriendlyName(cols[1]));
        chart.renderHorizontalGridLines(true);
        chart.elasticY(true);

        // Very small charts (i.e., Dashboard Cards) tend to render with an excessive number of ticks
        // set some limits on the ticks per pixel and adjust if needed
        adjustTicksIfNeeded(chart.yAxis(), chart.height(), MIN_PIXELS_PER_TICK.y);
        if (chart.rightYAxis) {
            adjustTicksIfNeeded(chart.rightYAxis(), chart.height(), MIN_PIXELS_PER_TICK.y);
        }
    } else {
        chart.yAxis().ticks(0);
        if (chart.rightYAxis) {
            chart.rightYAxis().ticks(0);
        }
    }
}

function applyChartTooltips(chart, onHoverChange) {
    chart.on("renderlet", function(chart) {
        chart.selectAll(".bar, .dot, .area, .line, g.pie-slice, g.features")
            .on("mousemove", function(d, i) {
                if (onHoverChange) {
                    onHoverChange(this, d, determineSeriesIndexFromElement(this));
                }
            })
            .on("mouseleave", function() {
                onHoverChange && onHoverChange(null);
            });

        chart.selectAll("title").remove();
    });
}

function applyChartLineBarSettings(chart, card, chartType) {
    // if the chart supports 'brushing' (brush-based range filter), disable this since it intercepts mouse hovers which means we can't see tooltips
    if (chart.brushOn) {
        chart.brushOn(false);
    }

    // LINE/AREA:
    // for chart types that have an 'interpolate' option (line/area charts), enable based on settings
    if (chart.interpolate) {
        if (card.visualization_settings.line.step) {
            chart.interpolate("step");
        } else {
            chart.interpolate(DEFAULT_INTERPOLATION);
        }
    }

    // AREA:
    if (chart.renderArea) {
        chart.renderArea(chartType === "area");
    }

    // BAR:
    if (chart.barPadding) {
        chart.barPadding(BAR_PADDING_RATIO);
    }
}

function lineAndBarOnRender(chart, card) {
    // once chart has rendered and we can access the SVG, do customizations to axis labels / etc that you can't do through dc.js
    let svg = chart.svg();
    let settings = card.visualization_settings;
    let x = settings.xAxis;
    let y = settings.yAxis;

    /// return a function to set attrName to attrValue for element(s) if attrValue is not null
    /// optional ATTRVALUETRANSFORMFN can be used to modify ATTRVALUE before it is set
    let customizer = function(element) {
        return function(attrName, attrValue, attrValueTransformFn) {
            if (attrValue) {
                if (attrValueTransformFn != null) {
                    attrValue = attrValueTransformFn(attrValue);
                }
                if (element.length != null) {
                    let len = element.length;
                    for (let i = 0; i < len; i++) {
                        element[i].setAttribute(attrName, attrValue);
                    }
                } else {
                    element.setAttribute(attrName, attrValue);
                }
            }
        };
    };
    // x-axis label customizations
    try {
        let customizeX = customizer(svg.select('.x-axis-label')[0][0]);
        customizeX('fill', x.title_color);
        customizeX('font-size', x.title_font_size);
    } catch (e) {}

    // y-axis label customizations
    try {
        let customizeY = customizer(svg.select('.y-axis-label')[0][0]);
        customizeY('fill', y.title_color);
        customizeY('font-size', y.title_font_size);
    } catch (e) {}

    // grid lines - .grid-line .horizontal, .vertical
    try {
        let customizeVertGL = customizer(svg.select('.grid-line.vertical')[0][0].children);
        customizeVertGL('stroke-width', x.gridLineWidth);
        customizeVertGL('style', x.gridLineColor, (colorStr) => 'stroke:' + colorStr + ';');
    } catch (e) {}

    try {
        let customizeHorzGL = customizer(svg.select('.grid-line.horizontal')[0][0].children);
        customizeHorzGL('stroke-width', y.gridLineWidth);
        customizeHorzGL('style', y.gridLineColor, (colorStr) => 'stroke:' + '#ddd' + ';');
    } catch (e) {}

    chart.on("renderlet.lineAndBarOnRender", (chart) => {
        for (let elem of chart.selectAll(".sub, .chart-body")[0]) {
            // prevents dots from being clipped:
            elem.removeAttribute("clip-path");
            // move chart content on top of axis (z-index doesn't work on SVG):
            elem.parentNode.appendChild(elem);
        }
        for (let elem of chart.svg().selectAll('.dc-tooltip circle.dot')[0]) {
            // set the color of the dots to the fill color so we can use currentColor in CSS rules:
            elem.style.color = elem.getAttribute("fill");
        }
    });

    // adjust the margins to fit the Y-axis tick label sizes, and rerender
    chart.margins().left = chart.select(".axis.y")[0][0].getBBox().width + 30;
    chart.margins().bottom = chart.select(".axis.x")[0][0].getBBox().height + 30;

    chart.render();
}

export let CardRenderer = {
    pie(element, { card, data: result, onHoverChange }) {
        let settings = card.visualization_settings;
        let data = result.rows.map(row => ({
            key: row[0],
            value: row[1]
        }));
        let sumTotalValue = data.reduce((acc, d) => acc + d.value, 0);

        // TODO: by default we should set a max number of slices of the pie and group everything else together

        // build crossfilter dataset + dimension + base group
        let dataset = crossfilter(data);
        let dimension = dataset.dimension(d => d.key);
        let group = dimension.group().reduceSum(d => d.value);
        let chart = initializeChart(card, element)
                        .dimension(dimension)
                        .group(group)
                        .colors(settings.pie.colors)
                        .colorCalculator((d, i) => settings.pie.colors[((i * 5) + Math.floor(i / 5)) % settings.pie.colors.length])
                        .label(row => formatValue(row.key, result.cols[0]))
                        .title(d => {
                            // ghetto rounding to 1 decimal digit since Math.round() doesn't let
                            // you specify a precision and always rounds to int
                            let percent = Math.round((d.value / sumTotalValue) * 1000) / 10.0;
                            return d.key + ': ' + d.value + ' (' + percent + '%)';
                        });

        // disables ability to select slices
        chart.filter = () => {};

        applyChartTooltips(chart, onHoverChange);

        chart.render();
    },

    lineAreaBar(element, chartType, { series, onHoverChange, onRender }) {
        let { card, data: result } = series[0];

        const colors = getCardColors(card);

        let isTimeseries = dimensionIsTimeseries(result);
        let isStacked = chartType === "area";
        let isLinear = false;

        // validation.  we require at least 2 rows for line charting
        if (result.cols.length < 2) {
            return;
        }

        // pre-process data
        let data = result.rows.map((row) => {
            // IMPORTANT: clone the data if you are going to modify it in any way
            let tuple = row.slice(0);
            tuple[0] = (isTimeseries) ? new Date(row[0]) : row[0];
            return tuple;
        });

        // build crossfilter dataset + dimension + base group
        let dataset = crossfilter();
        series.map((s, index) =>
            dataset.add(s.data.rows.map(row => ({
                x: (isTimeseries) ? new Date(row[0]) : row[0],
                ["y"+index]: row[1]
            })))
        );

        let dimension = dataset.dimension(d => d.x);
        let groups = series.map((s, index) =>
            dimension.group().reduceSum(d => (d["y"+index] || 0))
        );

        let xValues = dimension.group().all().map(d => d.key);
        let yExtents = groups.map(group => d3.extent(group.all(), d => d.value));
        let yAxisSplit = computeSplit(yExtents);

        let chart;
        if (isStacked || series.length === 1) {
            chart = initializeChart(series[0].card, element)
                        .dimension(dimension)
                        .group(groups[0]);

            // apply any stacked series if applicable
            for (let i = 1; i < groups.length; i++) {
                chart.stack(groups[i]);
            }

            applyChartLineBarSettings(chart, card, chartType);

            chart.ordinalColors(colors);
        } else {
            chart = initializeChart(card, element, "compositeChart")

            let subCharts = series.map(s =>
                dc[getDcjsChartType(series[0].card.display)](chart)
            );

            subCharts.forEach((subChart, index) => {
                subChart
                    .dimension(dimension)
                    .group(groups[index])
                    .colors(colors[index % colors.length])
                    .useRightYAxis(yAxisSplit.length > 1 && yAxisSplit[1].includes(index))

                applyChartLineBarSettings(subChart, card, chartType);

                // BAR:
                if (subChart.barPadding) {
                    subChart
                        .barPadding(BAR_PADDING_RATIO)
                        .centerBar(isLinear)
                }
            });

            chart
                .compose(subCharts)
                .on("renderlet.groupedbar", function (chart) {
                    // HACK: dc.js doesn't support grouped bar charts so we need to manually resize/reposition them
                    // https://github.com/dc-js/dc.js/issues/558
                    let barCharts = chart.selectAll(".sub rect:first-child")[0].map(node => node.parentNode.parentNode.parentNode);
                    if (barCharts.length > 0) {
                        let oldBarWidth = parseFloat(barCharts[0].querySelector("rect").getAttribute("width"));
                        let newBarWidthTotal = oldBarWidth / barCharts.length;
                        let seriesPadding =
                            newBarWidthTotal < 4 ? 0 :
                            newBarWidthTotal < 8 ? 1 :
                                                   2;
                        let newBarWidth = Math.max(1, newBarWidthTotal - seriesPadding);

                        chart.selectAll("g.sub rect").attr("width", newBarWidth);
                        barCharts.forEach((barChart, index) => {
                            barChart.setAttribute("transform", "translate(" + ((newBarWidth + seriesPadding) * index) + ", 0)");
                        });
                    }
                })

            // HACK: compositeChart + ordinal X axis shenanigans
            if (chartType === "bar") {
                chart._rangeBandPadding(BAR_PADDING_RATIO) // https://github.com/dc-js/dc.js/issues/678
            } else {
                chart._rangeBandPadding(1) // https://github.com/dc-js/dc.js/issues/662
            }
        }

        // x-axis settings
        // TODO: we should support a linear (numeric) x-axis option
        if (isTimeseries) {
            applyChartTimeseriesXAxis(chart, card, result.cols, xValues);
        } else {
            applyChartOrdinalXAxis(chart, card, result.cols, xValues);
        }

        // y-axis settings
        // TODO: if we are multi-series this could be split axis
        applyChartYAxis(chart, card, result.cols, data);

        applyChartTooltips(chart, (e, d, seriesIndex) => {
            if (onHoverChange) {
                // disable tooltips on lines
                if (e && e.classList.contains("line")) {
                    e = null;
                }
                onHoverChange(e, d, seriesIndex);
            }
        });

        // if the chart supports 'brushing' (brush-based range filter), disable this since it intercepts mouse hovers which means we can't see tooltips
        if (chart.brushOn) {
            chart.brushOn(false);
        }

        // render
        chart.render();

        // apply any on-rendering functions
        lineAndBarOnRender(chart, card);

        onRender && onRender({ yAxisSplit });
    },

    bar(element, props) {
        return CardRenderer.lineAreaBar(element, "bar", props);
    },

    line(element, props) {
        return CardRenderer.lineAreaBar(element, "line", props);
    },

    area(element, props) {
        return CardRenderer.lineAreaBar(element, "area", props);
    },

    state(element, { card, data, onHoverChange }) {
        let chartData = data.rows.map(value => ({
            stateCode: value[0],
            value: value[1]
        }));

        let chartRenderer = new GeoHeatmapChartRenderer(element, card, data)
            .setData(chartData, 'stateCode', 'value')
            .setJson('/app/charts/us-states.json', d => d.properties.name)
            .setProjection(d3.geo.albersUsa())
            .customize(chart => {
                applyChartTooltips(chart, (e, d, seriesIndex) => {
                    if (onHoverChange) {
                        if (d) {
                            let row = _.findWhere(data.rows, { [0]: d.properties.name });
                            d = row != null && {
                                data: { key: row[0], value: row[1] }
                            };
                        }
                        onHoverChange(e, d, seriesIndex);
                    }
                });
            })
            .render();

        return chartRenderer;
    },

    country(element, { card, data, onHoverChange }) {
        let chartData = data.rows.map(value => {
            // Does this actually make sense? If country is > 2 characters just use the first 2 letters as the country code ?? (WTF)
            let countryCode = value[0];
            if (typeof countryCode === "string") {
                countryCode = countryCode.substring(0, 2).toUpperCase();
            }

            return {
                code: countryCode,
                value: value[1]
            };
        });

        let chartRenderer = new GeoHeatmapChartRenderer(element, card, data)
            .setData(chartData, 'code', 'value')
            .setJson('/app/charts/world.json', d => d.properties.ISO_A2) // 2-letter country code
            .setProjection(d3.geo.mercator())
            .customize(chart => {
                applyChartTooltips(chart, (e, d, seriesIndex) => {
                    if (onHoverChange) {
                        if (d) {
                            let row = _.findWhere(data.rows, { [0]: d.properties.ISO_A2 });
                            d = row != null && {
                                data: { key: d.properties.NAME, value: row[1] }
                            };
                        }
                        onHoverChange(e, d, seriesIndex);
                    }
                });
            })
            .render();

        return chartRenderer;
    },

    pin_map(element, card, updateMapCenter, updateMapZoom) {
        let query = card.dataset_query;
        let vs = card.visualization_settings;
        let latitude_dataset_col_index = vs.map.latitude_dataset_col_index;
        let longitude_dataset_col_index = vs.map.longitude_dataset_col_index;
        let latitude_source_table_field_id = vs.map.latitude_source_table_field_id;
        let longitude_source_table_field_id = vs.map.longitude_source_table_field_id;

        if (latitude_dataset_col_index == null || longitude_dataset_col_index == null) {
            return;
        }

        if (latitude_source_table_field_id == null || longitude_source_table_field_id == null) {
            throw ("Map ERROR: latitude and longitude column indices must be specified");
        }
        if (latitude_dataset_col_index == null || longitude_dataset_col_index == null) {
            throw ("Map ERROR: unable to find specified latitude / longitude columns in source table");
        }

        let mapOptions = {
            zoom: vs.map.zoom,
            center: new google.maps.LatLng(vs.map.center_latitude, vs.map.center_longitude),
            mapTypeId: google.maps.MapTypeId.MAP,
            scrollwheel: false
        };

        let markerImageMapType = new google.maps.ImageMapType({
            getTileUrl: (coord, zoom) =>
                '/api/tiles/' + zoom + '/' + coord.x + '/' + coord.y + '/' +
                    latitude_source_table_field_id + '/' + longitude_source_table_field_id + '/' +
                    latitude_dataset_col_index + '/' + longitude_dataset_col_index + '/' +
                    '?query=' + encodeURIComponent(JSON.stringify(query))
            ,
            tileSize: new google.maps.Size(256, 256)
        });

        let height = getAvailableCanvasHeight(element);
        if (height != null) {
            element.style.height = height + "px";
        }

        let width = getAvailableCanvasWidth(element);
        if (width != null) {
            element.style.width = width + "px";
        }

        let map = new google.maps.Map(element, mapOptions);

        map.overlayMapTypes.push(markerImageMapType);

        map.addListener("center_changed", () => {
            let center = map.getCenter();
            updateMapCenter(center.lat(), center.lng());
        });

        map.addListener("zoom_changed", () => {
            updateMapZoom(map.getZoom());
        });

        /* We need to trigger resize at least once after
         * this function (re)configures the map, because if
         * a map already existed in this div (i.e. this
         * function was called as a result of a settings
         * change), then the map will re-render with
         * the new options once resize is called.
         * Otherwise, the map will not re-render.
         */
        google.maps.event.trigger(map, 'resize');

        //listen for resize event (internal to CardRenderer)
        //to let google maps api know about the resize
        //(see https://developers.google.com/maps/documentation/javascript/reference)
        element.addEventListener('cardrenderer-card-resized', () => google.maps.event.trigger(map, 'resize'));
    }
};
