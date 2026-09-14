"use client";

import React,{ useLayoutEffect,useRef,useState } from "react";

interface DataPoint {
  label: string;
  value: number;
}

interface SimpleLineChartProps {
  data: DataPoint[];
  height?: number;
  color?: string;
  showGrid?: boolean;
  title?: string;
  /** Draw a dashed horizontal reference line at this y-value (e.g. the average). */
  avgLine?: number;
  /** Label shown next to the reference line; defaults to the value. */
  avgLabel?: string;
  /** Format y-axis tick + reference-line values (e.g. ms → "3.6s"). */
  formatValue?: (value: number) => string;
}

export function SimpleLineChart({
  data,
  height = 200,
  color = "rgb(59, 130, 246)", // blue-500
  showGrid = true,
  title,
  avgLine,
  avgLabel,
  formatValue,
}: SimpleLineChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  // Mirrors the SVG's actual rendered pixel width so the viewBox always matches it 1:1.
  // Without this, a fixed 800-unit viewBox stretched via preserveAspectRatio="none" onto a
  // much wider rendered box scales X and Y unevenly, turning circular data points into
  // ellipses and stretching stroke widths/glyphs — this keeps the scale factor at 1 in both
  // axes instead, so nothing needs to be drawn anisotropically.
  const [measuredWidth, setMeasuredWidth] = useState(800);

  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => {
      const width = el.getBoundingClientRect().width;
      if (width > 0) setMeasuredWidth(width);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground">
        No data available
      </div>
    );
  }

  const padding = { top: 20, right: 20, bottom: 40, left: 50 };
  const chartWidth = measuredWidth;
  const chartHeight = height;
  const innerWidth = chartWidth - padding.left - padding.right;
  const innerHeight = chartHeight - padding.top - padding.bottom;

  // Include avgLine in the y-domain so the reference line is always visible.
  const domainValues = [...data.map((d) => d.value), ...(avgLine != null ? [avgLine] : [])];
  const maxValue = Math.max(...domainValues);
  const minValue = Math.min(...domainValues);
  const valueRange = maxValue - minValue || 1;

  const xScale = (index: number) => (index / (data.length - 1 || 1)) * innerWidth + padding.left;
  const yScale = (value: number) =>
    chartHeight - padding.bottom - ((value - minValue) / valueRange) * innerHeight;

  // Resolve SVG x coordinate → nearest data index
  const xToIndex = (clientX: number): number => {
    if (!svgRef.current) return 0;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * chartWidth;
    const ratio = Math.max(0, Math.min(1, (svgX - padding.left) / innerWidth));
    return Math.round(ratio * (data.length - 1));
  };

  const pathData = data
    .map((point, index) => {
      const x = xScale(index);
      const y = yScale(point.value);
      return index === 0 ? `M ${x} ${y}` : `L ${x} ${y}`;
    })
    .join(" ");

  const areaPathData = `${pathData} L ${xScale(data.length - 1)} ${chartHeight - padding.bottom} L ${xScale(0)} ${chartHeight - padding.bottom} Z`;

  const yTicks = 5;
  const yTickValues = Array.from({ length: yTicks }, (_, i) => {
    const value = minValue + (valueRange / (yTicks - 1)) * i;
    return Math.round(value);
  });

  // Drag selection (normalize so lo <= hi)
  const selLo = dragStart !== null && dragEnd !== null ? Math.min(dragStart, dragEnd) : null;
  const selHi = dragStart !== null && dragEnd !== null ? Math.max(dragStart, dragEnd) : null;
  const hasDragSelection = selLo !== null && selHi !== null && selLo !== selHi;

  // % change: always from left point to right point
  let pctChange: number | null = null;
  if (hasDragSelection) {
    const startVal = data[selLo!].value;
    const endVal = data[selHi!].value;
    pctChange = startVal !== 0 ? ((endVal - startVal) / startVal) * 100 : endVal > 0 ? 100 : 0;
  }

  // Tooltip display index: during drag show the end of drag, otherwise hovered
  const tooltipIndex = isDragging ? dragEnd : hoveredIndex;
  const tooltipPoint = tooltipIndex !== null ? data[tooltipIndex] : null;
  const tooltipX = tooltipIndex !== null ? xScale(tooltipIndex) : 0;
  const tooltipY = tooltipIndex !== null ? yScale(data[tooltipIndex].value) : 0;

  const handleMouseDown = (e: React.MouseEvent) => {
    const idx = xToIndex(e.clientX);
    setDragStart(idx);
    setDragEnd(idx);
    setIsDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const idx = xToIndex(e.clientX);
    setHoveredIndex(idx);
    if (isDragging) {
      setDragEnd(idx);
    }
  };

  const handleMouseUp = () => {
    if (isDragging) {
      setIsDragging(false);
      // If it was just a click (no real drag), clear the selection
      if (dragStart === dragEnd) {
        setDragStart(null);
        setDragEnd(null);
      }
    }
  };

  const handleMouseLeave = () => {
    setHoveredIndex(null);
    if (isDragging) {
      setIsDragging(false);
    }
  };

  // Click to clear selection when not starting a new drag
  const handleClick = () => {
    if (!isDragging && hasDragSelection) {
      setDragStart(null);
      setDragEnd(null);
    }
  };

  const isPositive = pctChange !== null && pctChange >= 0;
  const selColor = isPositive ? "rgb(34, 197, 94)" : "rgb(239, 68, 68)"; // green-500 / red-500

  return (
    <div className="w-full">
      {title && <h4 className="text-sm font-medium mb-4">{title}</h4>}
      <svg
        ref={svgRef}
        width="100%"
        height={chartHeight}
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        // chartWidth tracks the actual rendered pixel width (see the ResizeObserver above),
        // so this stretch is always ~1:1 in both axes — "none" just guards the brief window
        // before the first measurement, or if ResizeObserver is unavailable, so points at the
        // edges still line up with the mouse instead of being letterboxed by "meet" scaling.
        preserveAspectRatio="none"
        className="overflow-visible select-none"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        style={{ cursor: isDragging ? "col-resize" : "crosshair" }}
      >
        {/* Grid lines */}
        {showGrid && (
          <g className="opacity-10">
            {yTickValues.map((value, i) => (
              <line
                key={`grid-${i}`}
                x1={padding.left}
                y1={yScale(value)}
                x2={chartWidth - padding.right}
                y2={yScale(value)}
                stroke="currentColor"
                strokeWidth="1"
              />
            ))}
          </g>
        )}

        {/* Drag selection highlight */}
        {hasDragSelection && (
          <rect
            x={xScale(selLo!)}
            y={padding.top}
            width={xScale(selHi!) - xScale(selLo!)}
            height={innerHeight}
            fill={selColor}
            fillOpacity="0.08"
          />
        )}

        {/* Area under line */}
        <path
          d={areaPathData}
          fill={color}
          fillOpacity="0.1"
        />

        {/* Line */}
        <path
          d={pathData}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Average reference line */}
        {avgLine != null && (
          <g style={{ pointerEvents: "none" }}>
            <line
              x1={padding.left}
              y1={yScale(avgLine)}
              x2={chartWidth - padding.right}
              y2={yScale(avgLine)}
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray="6 3"
              className="text-muted-foreground opacity-70"
            />
            <text
              x={chartWidth - padding.right}
              y={yScale(avgLine) - 5}
              textAnchor="end"
              className="text-xs fill-current text-muted-foreground"
            >
              {avgLabel ?? (formatValue ? formatValue(avgLine) : String(avgLine))}
            </text>
          </g>
        )}

        {/* Drag selection boundary lines */}
        {hasDragSelection && (
          <>
            <line
              x1={xScale(selLo!)} y1={padding.top}
              x2={xScale(selLo!)} y2={chartHeight - padding.bottom}
              stroke={selColor} strokeWidth="1.5" strokeDasharray="4 2" opacity="0.6"
            />
            <line
              x1={xScale(selHi!)} y1={padding.top}
              x2={xScale(selHi!)} y2={chartHeight - padding.bottom}
              stroke={selColor} strokeWidth="1.5" strokeDasharray="4 2" opacity="0.6"
            />
          </>
        )}

        {/* Hover vertical guide line (only when not dragging or in selection) */}
        {!hasDragSelection && !isDragging && hoveredIndex !== null && (
          <line
            x1={tooltipX}
            y1={padding.top}
            x2={tooltipX}
            y2={chartHeight - padding.bottom}
            stroke={color}
            strokeWidth="1"
            strokeDasharray="4 2"
            opacity="0.4"
          />
        )}

        {/* Data points */}
        {data.map((point, index) => {
          const isInSelection = hasDragSelection && index >= selLo! && index <= selHi!;
          const isEndpoint = hasDragSelection && (index === selLo || index === selHi);
          const isHovered = hoveredIndex === index;
          const highlight = isEndpoint || isHovered;
          return (
            <circle
              key={index}
              cx={xScale(index)}
              cy={yScale(point.value)}
              r={highlight ? 6 : isInSelection ? 4.5 : 4}
              fill={isInSelection ? selColor : color}
              stroke={highlight ? "white" : "none"}
              strokeWidth={highlight ? 2 : 0}
              className="transition-all duration-100"
              style={{ pointerEvents: "none" }}
            />
          );
        })}

        {/* % change badge (centered in selection) */}
        {hasDragSelection && pctChange !== null && (
          (() => {
            const midX = (xScale(selLo!) + xScale(selHi!)) / 2;
            const sign = pctChange >= 0 ? "+" : "";
            const arrow = pctChange >= 0 ? "\u25B2" : "\u25BC";
            const pctText = `${arrow} ${sign}${pctChange.toFixed(1)}%`;
            const rangeText = `${data[selLo!].label} \u2192 ${data[selHi!].label}`;
            const boxWidth = 160;
            const boxHeight = 44;
            const clampedX = Math.max(padding.left + boxWidth / 2, Math.min(chartWidth - padding.right - boxWidth / 2, midX));
            return (
              <g style={{ pointerEvents: "none" }}>
                <rect
                  x={clampedX - boxWidth / 2}
                  y={padding.top - 2}
                  width={boxWidth}
                  height={boxHeight}
                  rx={8}
                  fill="hsl(var(--popover))"
                  stroke={selColor}
                  strokeWidth="1.5"
                  filter="drop-shadow(0 2px 4px rgba(0,0,0,0.15))"
                />
                <text
                  x={clampedX}
                  y={padding.top + 16}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={selColor}
                  fontSize="15"
                  fontWeight="700"
                >
                  {pctText}
                </text>
                <text
                  x={clampedX}
                  y={padding.top + 30}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="hsl(var(--muted-foreground))"
                  fontSize="11"
                >
                  {rangeText}
                </text>
              </g>
            );
          })()
        )}

        {/* Single-point hover tooltip (only when not dragging and no selection) */}
        {!hasDragSelection && !isDragging && tooltipPoint && tooltipIndex !== null && (() => {
          const labelText = tooltipPoint.label;
          const valueText = formatValue ? formatValue(tooltipPoint.value) : tooltipPoint.value.toLocaleString();
          const totalChars = labelText.length + valueText.length + 3;
          const boxWidth = Math.max(totalChars * 7.5 + 20, 80);
          const halfBox = boxWidth / 2;
          const clampedX = Math.max(padding.left + halfBox, Math.min(chartWidth - padding.right - halfBox, tooltipX));
          return (
            <g style={{ pointerEvents: "none" }}>
              <rect
                x={clampedX - halfBox}
                y={tooltipY - 44}
                width={boxWidth}
                height={34}
                rx={6}
                fill="hsl(var(--popover))"
                stroke="hsl(var(--border))"
                strokeWidth="1"
                filter="drop-shadow(0 1px 2px rgba(0,0,0,0.1))"
              />
              <text
                x={clampedX}
                y={tooltipY - 27}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize="12"
              >
                <tspan fill="hsl(var(--muted-foreground))">{labelText}  </tspan>
                <tspan fill="hsl(var(--popover-foreground))" fontWeight="700" fontSize="13">{valueText}</tspan>
              </text>
            </g>
          );
        })()}

        {/* Y-axis */}
        <line
          x1={padding.left}
          y1={padding.top}
          x2={padding.left}
          y2={chartHeight - padding.bottom}
          stroke="currentColor"
          strokeWidth="1"
          className="opacity-30"
        />

        {/* Y-axis labels */}
        {yTickValues.map((value, i) => (
          <text
            key={`y-label-${i}`}
            x={padding.left - 10}
            y={yScale(value)}
            textAnchor="end"
            alignmentBaseline="middle"
            className="text-xs fill-current text-muted-foreground"
          >
            {formatValue ? formatValue(value) : value}
          </text>
        ))}

        {/* X-axis */}
        <line
          x1={padding.left}
          y1={chartHeight - padding.bottom}
          x2={chartWidth - padding.right}
          y2={chartHeight - padding.bottom}
          stroke="currentColor"
          strokeWidth="1"
          className="opacity-30"
        />

        {/* X-axis labels */}
        {data.map((point, index) => {
          const showLabel = data.length <= 10 || index % Math.ceil(data.length / 7) === 0;
          if (!showLabel) return null;
          return (
            <text
              key={`x-label-${index}`}
              x={xScale(index)}
              y={chartHeight - padding.bottom + 20}
              textAnchor="middle"
              className="text-xs fill-current text-muted-foreground"
            >
              {point.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
