import { FormEvent, useEffect, useMemo, useState, ReactNode, useRef } from "react";
import { createPortal } from "react-dom";
import { Link, Route, Routes, useNavigate, useParams, useSearchParams, Navigate } from "react-router-dom";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Analytics } from "@vercel/analytics/react";

type ReplayArchetype = {
  groupId: number;
  name: string;
  coverCardName: string | null;
  coverImagePath: string | null;
  coverImageCroppedPath: string | null;
  matchedUniqueCount: number;
  matchedCards: string[];
};

type ReplayPlayerListItem = {
  username: string;
  rating: number | null;
  won: boolean;
  archetypes: ReplayArchetype[];
};

type ReplayListItem = {
  duelId: number;
  winner: string | null;
  loser: string | null;
  finalScore: string | null;
  gamesPlayed: number;
  plays: number;
  durationSeconds: number;
  replayUrl: string | null;
  completedAt: string | null;
  players: ReplayPlayerListItem[];
};

type ReplayListResponse = {
  items: ReplayListItem[];
  total: number;
  page: number;
  pageSize: number;
};

type ReplayGameRow = {
  gameNumber: number;
  scoreAtStart: string;
  startingPlayer: string | null;
  winner: string | null;
  plays: number;
};

type ReplayActionRow = {
  sequence: number;
  play: string;
  username: string | null;
  seconds: number | null;
  cardName: string | null;
  message: string | null;
  score: string | null;
};

type ReplayPlayerDetail = {
  username: string;
  rating: number | null;
  won: boolean;
  plays: number;
  uniqueCardCount: number;
  uniqueCards: Array<{ name: string; imagePath: string | null; detail?: any }>;
  archetypes: ReplayArchetype[];
};

type ReplayDetail = {
  duelId: number;
  winner: string | null;
  loser: string | null;
  finalScore: string | null;
  gamesPlayed: number;
  plays: number;
  durationSeconds: number;
  replayUrl: string | null;
  players: ReplayPlayerDetail[];
  games: ReplayGameRow[];
  actions: ReplayActionRow[];
};

type ArchetypeGroup = {
  id: number;
  name: string;
  threshold: number;
  enabled: boolean;
  coverCardName: string | null;
  coverImagePath: string | null;
  coverImageCroppedPath: string | null;
  cards: string[];
  matchCount: number;
  updatedAt: string;
};

type ReclassificationJob = {
  id: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
  summaryJson: string | null;
  errorText: string | null;
} | null;

type CardSearchResult = {
  cardId: number;
  name: string;
  imagePath: string | null;
  imageCroppedPath: string | null;
};

type HighlightedArchetype = {
  id: number;
  name: string;
  coverCardName: string | null;
  coverImagePath: string | null;
  coverImageCroppedPath: string | null;
  matchCount: number;
};

type SearchSuggestion = {
  value: string;
  kind: "player" | "archetype" | "card";
  imagePath: string | null;
  imageCroppedPath: string | null;
};

function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function formatTime(value: string | null) {
  if (!value) {
    return "n/a";
  }
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status}:${body || `Request failed with ${response.status}`}`);
  }

  return (await response.json()) as T;
}

/* ── Shared components ─────────────────────────────── */

function ScoreBadge({ score, color = "accent" }: { score: string | null; color?: "accent" | "success" }) {
  if (!score) return <span className="muted">n/a</span>;
  const matches = score.match(/\d+/g);
  const left = matches?.[0] ?? "0";
  const right = matches?.[1] ?? "0";
  const isSuccess = color === "success";
  const bg = isSuccess ? "rgba(74, 222, 128, 0.15)" : "rgba(240,178,50,0.15)";
  const fg = isSuccess ? "var(--success)" : "var(--accent-light)";

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.1rem" }}>
      <span style={{ display: "inline-flex", justifyContent: "center", width: 24, padding: "2px 0", background: bg, color: fg, borderRadius: 4 }}>
        {left}
      </span>
      <span className="muted" style={{ fontSize: "0.8rem" }}>vs</span>
      <span style={{ display: "inline-flex", justifyContent: "center", width: 24, padding: "2px 0", background: bg, color: fg, borderRadius: 4 }}>
        {right}
      </span>
    </div>
  );
}

function ArchetypeOverflow({ arch, overflowArchetypes }: { arch: any, overflowArchetypes: any[] }) {
  const [hovering, setHovering] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  return (
    <>
      <div 
        ref={ref} 
        style={{ position: "relative", cursor: "pointer" }}
        onMouseEnter={() => {
          if (ref.current) {
            const rect = ref.current.getBoundingClientRect();
            setPos({ x: rect.left + rect.width / 2, y: rect.top });
          }
          setHovering(true);
        }}
        onMouseLeave={() => setHovering(false)}
      >
        <Tooltip text={arch.name}>
          {arch.coverImageCroppedPath ? <img src={arch.coverImageCroppedPath} alt={arch.name} className="archetype-gallery-img" /> : <div className="archetype-gallery-fallback">?</div>}
        </Tooltip>
        
        <div style={{
          position: "absolute",
          top: -6,
          right: -6,
          background: "var(--accent)",
          color: "var(--bg)",
          borderRadius: "12px",
          padding: "2px 6px",
          fontSize: "0.75rem",
          fontWeight: 800,
          boxShadow: "0 2px 4px rgba(0,0,0,0.5)"
        }}>
          +{overflowArchetypes.length}
        </div>
      </div>
      {hovering && createPortal(
        <div className="archetype-overflow-portal" style={{ left: pos.x, top: pos.y - 10 }}>
          {overflowArchetypes.map(overflowArch => (
            <div key={overflowArch.name} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {overflowArch.coverImageCroppedPath ? <img src={overflowArch.coverImageCroppedPath} alt={overflowArch.name} style={{ width: 48, height: 48, borderRadius: 4, objectFit: "cover" }} /> : <div className="archetype-gallery-fallback" style={{ width: 48, height: 48, fontSize: "1.2rem" }}>?</div>}
              <span style={{ fontSize: "1rem", fontWeight: 600, color: "var(--text-1)", whiteSpace: "nowrap" }}>{overflowArch.name}</span>
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

function Tooltip({ text, children, style, className }: { text: string; children: ReactNode; style?: React.CSSProperties; className?: string }) {
  return (
    <span className={`tip ${className ?? ""}`} style={style}>
      {children}
      <span className="tip-text">{text}</span>
    </span>
  );
}

function ArchetypeChips({ archetypes }: { archetypes: ReplayArchetype[] }) {
  if (archetypes.length === 0) {
    return (
      <div className="archetype-cluster">
        <div className="archetype-chip large unknown">
          <div className="archetype-fallback">?</div>
          <span>Unknown</span>
        </div>
      </div>
    );
  }

  return (
    <div className="archetype-cluster">
      {archetypes.map((archetype) => (
        <div className="archetype-chip large" key={`${archetype.groupId}-${archetype.name}`}>
          {archetype.coverImageCroppedPath ? (
            <img src={archetype.coverImageCroppedPath} alt={archetype.name} />
          ) : (
            <div className="archetype-fallback" />
          )}
          <span>{archetype.name}</span>
        </div>
      ))}
    </div>
  );
}

function SuggestionMenu({
  suggestions,
  onSelect,
  selectedValues,
}: {
  suggestions: SearchSuggestion[];
  onSelect: (value: string, kind: string) => void;
  selectedValues?: Set<string>;
}) {
  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div className="suggestion-menu">
      {suggestions.map((suggestion) => (
        <button
          key={`${suggestion.kind}:${suggestion.value}`}
          type="button"
          className={`suggestion-row ${selectedValues?.has(suggestion.value) ? "selected" : ""}`}
          onClick={() => onSelect(suggestion.value, suggestion.kind)}
        >
          {suggestion.imageCroppedPath ? (
            <span className="suggestion-thumb">
              <img src={suggestion.imageCroppedPath} alt={suggestion.value} />
            </span>
          ) : (
            <span className={`suggestion-kind suggestion-kind-${suggestion.kind}`}>{suggestion.kind.slice(0, 1).toUpperCase()}</span>
          )}
          <span className="suggestion-main">
            <span className="suggestion-value">{suggestion.value}</span>
            <span className="suggestion-meta">{suggestion.kind}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function LoadingSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="skeleton-grid">
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton-card" key={i}>
          <div className="skeleton-line skeleton-line--short" />
          <div className="skeleton-line skeleton-line--long" />
          <div className="skeleton-line skeleton-line--medium" />
          <div className="skeleton-line skeleton-line--long" />
        </div>
      ))}
    </div>
  );
}

function CardGalleryWithHover({ cards }: { cards: Array<{ name: string; imagePath: string | null; detail?: any }> }) {
  const [hoverCard, setHoverCard] = useState<{ card: any, x: number, y: number } | null>(null);

  return (
    <>
      <div className="card-gallery">
        {cards.map((card) => (
          <div 
            className="detail-card" 
            key={card.name}
            onMouseEnter={(e) => setHoverCard({ card, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => setHoverCard({ card, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setHoverCard(null)}
          >
            {card.imagePath ? <img src={card.imagePath} alt={card.name} /> : <div className="detail-card-placeholder">No image</div>}
          </div>
        ))}
      </div>
      {hoverCard && hoverCard.card.detail ? (
        <div 
          className="card-hover-portal" 
          style={{ 
            left: Math.min(window.innerWidth - 620, hoverCard.x + 20), 
            top: Math.max(20, Math.min(window.innerHeight - 500, hoverCard.y - 150)) 
          }}
        >
          <div className="card-hover-left">
            {hoverCard.card.imagePath && (
              <img src={hoverCard.card.imagePath} alt={hoverCard.card.detail.n} className="card-hover-img" />
            )}
          </div>
          <div className="card-hover-right">
            <div className="card-hover-head">
              <h3 style={{ fontSize: "1.4rem", margin: 0 }}>{hoverCard.card.detail.n}</h3>
              <div className="card-hover-meta" style={{ marginTop: 8 }}>
                {hoverCard.card.detail.att && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 700, color: "var(--text-1)" }}><span style={{ padding: "2px 6px", background: "rgba(255,255,255,0.1)", borderRadius: 4, fontSize: "0.75rem" }}>{hoverCard.card.detail.att}</span></span>}
                {hoverCard.card.detail.lvl && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 700, color: "var(--text-1)" }}><span style={{ padding: "2px 6px", background: "rgba(255,255,255,0.1)", borderRadius: 4, fontSize: "0.75rem" }}>Level/Rank {hoverCard.card.detail.lvl}</span></span>}
              </div>
            </div>
            {hoverCard.card.detail.typ && <div className="card-hover-typ" style={{ fontWeight: 700, color: "var(--text-1)", marginTop: 4 }}>[ {hoverCard.card.detail.typ} ]</div>}
            <div className="card-hover-desc" style={{ fontSize: "0.9rem", color: "var(--text-1)" }}>
              {hoverCard.card.detail.e}
            </div>
            {(hoverCard.card.detail.atk !== undefined || hoverCard.card.detail.def !== undefined) && (
              <div className="card-hover-stats" style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid var(--border)", fontSize: "1.1rem" }}>
                ATK/ {hoverCard.card.detail.atk ?? "?"} DEF/ {hoverCard.card.detail.def ?? "?"}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

function SiteHeader({ admin = false }: { admin?: boolean }) {
  return (
    <header className="site-header">
      <div className="site-brand">
        <Link to="/">
          <span className="site-brand__name">YugiTube</span>
        </Link>
        <span className="site-brand__tag">DuelingBook Replays</span>
      </div>
      <nav className="site-nav">
        <Link to="/">Browser</Link>
        {admin ? (
          <>
            <Link to="/matrix/archetypes">Archetypes</Link>
            <Link to="/matrix/workers">Workers</Link>
          </>
        ) : null}
      </nav>
    </header>
  );
}

/* ── Replay List Page ──────────────────────────────── */

function ReplayListPage() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ReplayListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchSuggestions, setSearchSuggestions] = useState<SearchSuggestion[]>([]);
  const [highlightedArchetypes, setHighlightedArchetypes] = useState<HighlightedArchetype[]>([]);
  const [gridRef] = useAutoAnimate<HTMLDivElement>();

  const queryString = params.toString();
  
  const [qText, setQText] = useState(params.get("q") ?? "");
  const [qFocused, setQFocused] = useState(false);

  useEffect(() => {
    setQText(params.get("q") ?? "");
  }, [params.get("q")]);

  useEffect(() => {
    if (qText === (params.get("q") ?? "")) return;
    const handler = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (qText) next.set("q", qText);
      else next.delete("q");
      next.set("page", "1");
      setParams(next);
    }, 400);
    return () => clearTimeout(handler);
  }, [qText, params]);

  const quickSearch = qText.trim();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchJson<ReplayListResponse>(`/api/replays?${queryString}`)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [queryString]);

  useEffect(() => {
    let cancelled = false;
    fetchJson<HighlightedArchetype[]>("/api/archetypes/highlighted")
      .then((result) => {
        if (!cancelled) {
          setHighlightedArchetypes(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHighlightedArchetypes([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (quickSearch.length < 2) {
      setSearchSuggestions([]);
      return;
    }

    let cancelled = false;
    Promise.all([
      fetchJson<string[]>(`/api/search/suggestions?type=player&q=${encodeURIComponent(quickSearch)}`),
      fetchJson<string[]>(`/api/search/suggestions?type=archetype&q=${encodeURIComponent(quickSearch)}`),
      fetchJson<CardSearchResult[]>(`/api/search/suggestions?type=card&q=${encodeURIComponent(quickSearch)}`),
    ])
      .then(([players, archetypes, cards]) => {
        if (cancelled) {
          return;
        }
        const merged: SearchSuggestion[] = [
          ...archetypes.map((value) => ({ value, kind: "archetype" as const, imagePath: null, imageCroppedPath: null })),
          ...players.map((value) => ({ value, kind: "player" as const, imagePath: null, imageCroppedPath: null })),
          ...cards.map((card) => ({ value: card.name, kind: "card" as const, imagePath: card.imagePath, imageCroppedPath: card.imageCroppedPath })),
        ].filter(
          (suggestion, index, list) =>
            list.findIndex((entry) => entry.value.toLowerCase() === suggestion.value.toLowerCase()) === index,
        ).slice(0, 12);
        setSearchSuggestions(merged);
      })
      .catch(() => {
        if (!cancelled) {
          setSearchSuggestions([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [quickSearch]);

  function updateFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    next.set("page", "1");
    setParams(next);
  }

  function toggleArchetype(name: string) {
    const next = new URLSearchParams(params);
    const current = next.getAll("archetype");
    next.delete("archetype");
    if (current.includes(name)) {
      current.filter(c => c !== name).forEach(c => next.append("archetype", c));
    } else {
      current.push(name);
      current.forEach(c => next.append("archetype", c));
    }
    next.set("page", "1");
    setParams(next);
  }

  function toggleCard(name: string) {
    const next = new URLSearchParams(params);
    const current = next.getAll("card");
    next.delete("card");
    if (current.includes(name)) {
      current.filter(c => c !== name).forEach(c => next.append("card", c));
    } else {
      current.push(name);
      current.forEach(c => next.append("card", c));
    }
    next.set("page", "1");
    setParams(next);
  }

  function applySuggestion(value: string, kind: string) {
    if (kind === "archetype") {
      toggleArchetype(value);
      setQText("");
    } else if (kind === "card") {
      toggleCard(value);
      setQText("");
    } else if (kind === "player") {
      updateFilter("player", value);
      setQText("");
    } else {
      setQText(value);
    }
    setQFocused(false);
  }

  function changePage(page: number) {
    const next = new URLSearchParams(params);
    next.set("page", String(page));
    setParams(next);
  }

  const page = Number(params.get("page") ?? "1");

  return (
    <div className="page-shell">
      <SiteHeader />

      <header className="page-title">
        <h1>Replay Browser</h1>
        <p>Search recent ladder matches, view decks, and analyze games.</p>
      </header>

      {highlightedArchetypes.length > 0 || params.getAll("card").length > 0 ? (
        <div className="highlight-strip">
          {highlightedArchetypes.map((archetype) => {
            const activeArchetypes = params.getAll("archetype");
            const active = activeArchetypes.includes(archetype.name);
            return (
              <button
                key={`arch-${archetype.id}`}
                type="button"
                className={`highlight-pill${active ? " active" : ""}`}
                onClick={() => toggleArchetype(archetype.name)}
              >
                {archetype.coverImageCroppedPath ? <img src={archetype.coverImageCroppedPath} alt={archetype.name} /> : <div className="archetype-fallback" />}
                <span>{archetype.name}</span>
              </button>
            );
          })}
          {params.getAll("card").map((card) => (
            <button
              key={`card-${card}`}
              type="button"
              className="highlight-pill active"
              onClick={() => toggleCard(card)}
              style={{ borderLeft: "4px solid var(--accent)" }}
            >
              <span>{card}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="filter-bar">
        <label>
          Search
          <div 
            className="autocomplete-field"
            onFocus={() => setQFocused(true)}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setQFocused(false); }}
          >
            <input
              value={qText}
              onChange={(event) => setQText(event.target.value)}
              placeholder="card, archetype, username"
            />
            {qFocused && (
              <SuggestionMenu 
                suggestions={searchSuggestions} 
                onSelect={applySuggestion} 
                selectedValues={new Set([...params.getAll("archetype"), ...params.getAll("card")])} 
              />
            )}
          </div>
        </label>
        <label>
          Rating Range
          <div className="range-inputs">
            <input value={params.get("minRating") ?? ""} onChange={(event) => updateFilter("minRating", event.target.value)} placeholder="Min (e.g. 300)" />
            <span className="muted" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>to</span>
            <input value={params.get("maxRating") ?? ""} onChange={(event) => updateFilter("maxRating", event.target.value)} placeholder="Max (e.g. 2000)" />
          </div>
        </label>
        <label>
          Sort
          <select value={params.get("sort") ?? "newest"} onChange={(event) => updateFilter("sort", event.target.value)}>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="plays_desc">Most plays</option>
            <option value="duration_desc">Longest duration</option>
            <option value="rating_desc">Highest average rating</option>
          </select>
        </label>
      </div>

      <div className="section-head">
        <div>
          <h2>Latest completed matches</h2>
        </div>
        {data ? (
          <div className="count-badge">
            <strong>{data.total}</strong> results
          </div>
        ) : null}
      </div>

      {loading ? <LoadingSkeleton /> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {data ? (
        <>
          <div className="replay-grid" ref={gridRef}>
            {data.items.map((item) => (
              <article className="replay-card" key={item.duelId}>
                <div className="replay-card-top" style={{ justifyContent: "center" }}>
                  <div style={{ display: "flex", gap: "24px", alignItems: "center", width: "100%" }}>
                    <div className="replay-player-info" style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "flex-end" }}>
                      <Tooltip text={`Rating: ${item.players[0]?.rating ?? "n/a"}`} style={{ minWidth: 0, maxWidth: "100%", display: "inline-block" }}>
                        <div className="replay-player-name" style={{ fontSize: "1.2rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{item.players[0]?.username}</div>
                      </Tooltip>
                    </div>
                    <Link to={`/replays/${item.duelId}`} style={{ display: "flex", textDecoration: "none", flexShrink: 0 }}>
                      <ScoreBadge score={item.finalScore} />
                    </Link>
                    <div className="replay-player-info" style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "flex-start" }}>
                      <Tooltip text={`Rating: ${item.players[1]?.rating ?? "n/a"}`} style={{ minWidth: 0, maxWidth: "100%", display: "inline-block" }}>
                        <div className="replay-player-name" style={{ fontSize: "1.2rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{item.players[1]?.username}</div>
                      </Tooltip>
                    </div>
                  </div>
                </div>

                <div className="replay-card-body" style={{ display: "flex", justifyContent: "center", marginTop: "12px", border: "none", paddingTop: 0 }}>
                  <div style={{ display: "flex", justifyContent: "flex-end", flex: 1 }}>
                    <div className="archetype-gallery" style={{ justifyContent: "flex-end" }}>
                      {item.players[0]?.archetypes.length ? (
                        <>
                          {item.players[0].archetypes.slice(0, 2).map((arch, index) => {
                            const isLast = index === 1 || (index === 0 && item.players[0].archetypes.length === 1);
                            const hasMore = item.players[0].archetypes.length > 2;

                            if (index === 1 && hasMore) {
                              return (
                                <ArchetypeOverflow 
                                  key={arch.name} 
                                  arch={arch} 
                                  overflowArchetypes={item.players[0].archetypes.slice(2)} 
                                />
                              );
                            }

                            return (
                              <Tooltip key={arch.name} text={arch.name}>
                                {arch.coverImageCroppedPath ? <img src={arch.coverImageCroppedPath} alt={arch.name} className="archetype-gallery-img" /> : <div className="archetype-gallery-fallback">?</div>}
                              </Tooltip>
                            );
                          })}
                        </>
                      ) : <div className="archetype-gallery-fallback">?</div>}
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "center", width: 60, flexShrink: 0 }}>
                    <div style={{ width: 1, background: "var(--border-strong)", margin: "4px 0" }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-start", flex: 1 }}>
                    <div className="archetype-gallery">
                      {item.players[1]?.archetypes.length ? (
                        <>
                          {item.players[1].archetypes.slice(0, 2).map((arch, index) => {
                            const isLast = index === 1 || (index === 0 && item.players[1].archetypes.length === 1);
                            const hasMore = item.players[1].archetypes.length > 2;

                            if (index === 1 && hasMore) {
                              return (
                                <ArchetypeOverflow 
                                  key={arch.name} 
                                  arch={arch} 
                                  overflowArchetypes={item.players[1].archetypes.slice(2)} 
                                />
                              );
                            }

                            return (
                              <Tooltip key={arch.name} text={arch.name}>
                                {arch.coverImageCroppedPath ? <img src={arch.coverImageCroppedPath} alt={arch.name} className="archetype-gallery-img" /> : <div className="archetype-gallery-fallback">?</div>}
                              </Tooltip>
                            );
                          })}
                        </>
                      ) : <div className="archetype-gallery-fallback">?</div>}
                    </div>
                  </div>
                </div>

                <div className="replay-card-bottom" style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                  <div className="replay-stats" style={{ display: "flex", gap: 8 }}>
                    <Tooltip text="Match duration">
                      <span>{formatDuration(item.durationSeconds)}</span>
                    </Tooltip>
                    <span className="replay-stats-sep">•</span>
                    <Tooltip text="Total Plays">
                      <span>{item.plays}P</span>
                    </Tooltip>
                    <span className="replay-stats-sep">•</span>
                    <Tooltip text="Games Played">
                      <span>{item.gamesPlayed}G</span>
                    </Tooltip>
                  </div>
                  <div className="replay-links" style={{ display: "flex", gap: 12 }}>
                    <Link to={`/replays/${item.duelId}`}>View details</Link>
                    {item.replayUrl ? (
                      <a href={item.replayUrl} target="_blank" rel="noreferrer" className="replay-ext">
                        Open DB ↗
                      </a>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
          </div>

          <div className="pagination">
            <button disabled={page <= 1} onClick={() => changePage(page - 1)}>
              ← Prev
            </button>
            <span>Page {data.page}</span>
            <button disabled={data.page * data.pageSize >= data.total} onClick={() => changePage(page + 1)}>
              Next →
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ── Replay Detail Page ────────────────────────────── */

function ReplayDetailPage() {
  const { duelId } = useParams();
  const [data, setData] = useState<ReplayDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [showChat, setShowChat] = useState(false);

  useEffect(() => {
    if (showChat) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [showChat]);

  useEffect(() => {
    if (!duelId) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchJson<ReplayDetail>(`/api/replays/${duelId}`)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [duelId]);

  return (
    <div className="page-shell">
      <SiteHeader />

      {loading ? <p className="loading-text">Loading replay...</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {data ? (
        <>
          <section className="summary-section">
            <div className="section-label">Replay #{data.duelId}</div>
            <h1>
              {data.winner ?? "Unknown"} vs {data.loser ?? "Unknown"}
            </h1>
            <div className="summary-metrics">
              <Tooltip text="Match Score">
                <span style={{ padding: "0 4px", display: "inline-flex", alignItems: "center" }}><ScoreBadge score={data.finalScore} /></span>
              </Tooltip>
              <Tooltip text="Games Played">
                <span className="summary-metric">{data.gamesPlayed} games</span>
              </Tooltip>
              <Tooltip text="Total Plays">
                <span className="summary-metric">{data.plays} plays</span>
              </Tooltip>
              <Tooltip text="Match Duration">
                <span className="summary-metric">{formatDuration(data.durationSeconds)}</span>
              </Tooltip>
            </div>
          </section>

          <section className="player-grid">
            {data.players.map((player) => (
              <article className="player-card" key={player.username}>
                <div className="player-card-head">
                  <div>
                    <h2>{player.username}</h2>
                    <p className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                      <Tooltip text="Player DB Rating">Rating: {player.rating ?? "n/a"}</Tooltip>
                    </p>
                  </div>
                  {player.won ? <span className="win-tag">Winner</span> : null}
                </div>
                <ArchetypeChips archetypes={player.archetypes} />
                <div className="player-stats">
                  <Tooltip text="Plays by this player">
                    <span className="player-stat-pill">{player.plays} plays</span>
                  </Tooltip>
                  <Tooltip text="Distinct cards used">
                    <span className="player-stat-pill">{player.uniqueCardCount} unique cards</span>
                  </Tooltip>
                </div>
                {/* Full card images here, as users want to see card text */}
                <CardGalleryWithHover cards={player.uniqueCards} />
              </article>
            ))}
          </section>

          <hr className="divider" />

          <section className="table-section">
            <div className="section-head">
              <h2>Match Games</h2>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Game</th>
                    <th>Start score</th>
                    <th>Starting player</th>
                    <th>Winner</th>
                    <th>Plays</th>
                  </tr>
                </thead>
                <tbody>
                  {data.games.map((game) => (
                    <tr key={game.gameNumber}>
                      <td>
                        <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: "50%", background: "var(--bg-input)", fontWeight: 600 }}>
                          {game.gameNumber}
                        </div>
                      </td>
                      <td>
                        <ScoreBadge score={game.scoreAtStart} />
                      </td>
                      <td>{game.startingPlayer ?? "n/a"}</td>
                      <td>
                        {game.winner ? (
                          <span style={{ color: "var(--accent-light)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                            {game.winner}
                          </span>
                        ) : (
                          <span className="muted">Draw / None</span>
                        )}
                      </td>
                      <td className="muted">{game.plays} plays</td>
                    </tr>
                  ))}
                  <tr style={{ background: "rgba(74, 222, 128, 0.05)" }}>
                    <td>
                      <span className="win-tag" style={{ border: "none", background: "transparent", padding: 0 }}>FINAL</span>
                    </td>
                    <td>
                      <ScoreBadge score={data.finalScore} color="success" />
                    </td>
                    <td colSpan={3} style={{ fontWeight: 600 }}>
                      {data.winner ? (
                        <span style={{ color: "var(--success)" }}>Match Winner: {data.winner}</span>
                      ) : (
                        <span className="muted">Match Drawn</span>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <hr className="divider" />

          {data.replayUrl ? (
            <button 
              onClick={() => {
                setShowActions(true);
                setTimeout(() => document.getElementById("interactive-replay-section")?.scrollIntoView({ behavior: "smooth" }), 100);
              }}
              style={{ 
                position: "fixed", bottom: "32px", left: "32px", 
                zIndex: 100, background: "var(--accent)", color: "var(--bg)", 
                border: "none", borderRadius: "32px", padding: "0 24px", height: "52px", boxSizing: "border-box",
                fontWeight: 600, fontSize: "1rem", boxShadow: "0 8px 24px rgba(240,178,50,0.4)",
                display: "flex", alignItems: "center", gap: "10px", cursor: "pointer",
                transition: "transform 0.2s, box-shadow 0.2s",
                textDecoration: "none"
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.05)"; e.currentTarget.style.boxShadow = "0 12px 32px rgba(240,178,50,0.5)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "0 8px 24px rgba(240,178,50,0.4)"; }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              Watch Replay
            </button>
          ) : null}

          {(() => {
            const messages = data.actions.filter(a => a.play === "Duel message");
            if (messages.length === 0) return null;
            return (
              <>
                <div style={{ position: "fixed", bottom: "32px", right: "32px", zIndex: 100 }}>
                  <button 
                    onClick={() => setShowChat(true)}
                    style={{ 
                      background: "var(--accent)", color: "var(--bg)", 
                      border: "none", borderRadius: "50%", width: "52px", height: "52px", 
                      boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
                      display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
                      transition: "transform 0.2s"
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.transform = "scale(1.05)"}
                    onMouseLeave={(e) => e.currentTarget.style.transform = "scale(1)"}
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                  </button>
                  <div style={{
                    position: "absolute", top: "-4px", right: "-4px",
                    background: "var(--error)", color: "#fff",
                    borderRadius: "12px", padding: "2px 6px",
                    fontSize: "0.75rem", fontWeight: 800,
                    boxShadow: "0 2px 4px rgba(0,0,0,0.4)", pointerEvents: "none"
                  }}>
                    {messages.length}
                  </div>
                </div>

                <div 
                  onClick={() => setShowChat(false)}
                  style={{ 
                  position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 200, display: "flex", justifyContent: "flex-end", 
                  background: showChat ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0)", 
                  backdropFilter: showChat ? "blur(2px)" : "blur(0px)",
                  pointerEvents: showChat ? "auto" : "none",
                  transition: "background 0.3s ease, backdrop-filter 0.3s ease"
                }}>
                  <div 
                    onClick={(e) => e.stopPropagation()}
                    style={{ 
                    width: "380px", maxWidth: "100%", height: "100%", background: "var(--bg)", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", boxShadow: "-8px 0 32px rgba(0,0,0,0.5)",
                    transform: showChat ? "translateX(0)" : "translateX(100%)",
                    transition: "transform 0.3s var(--ease)"
                  }}>
                      <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--bg-input)" }}>
                        <h3 style={{ margin: 0, fontSize: "1.1rem" }}>Match Chat</h3>
                        <button onClick={() => setShowChat(false)} className="btn-ghost btn-sm" style={{ padding: "6px 12px" }}>Close</button>
                      </div>
                      <div style={{ flex: 1, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: 0 }}>
                        {messages.map((action, index) => {
                          const isP1 = action.username === data.players[0]?.username;
                          const isP2 = action.username === data.players[1]?.username;
                          const isSystem = !isP1 && !isP2;
                          
                          const previousMessage = index > 0 ? messages[index - 1] : null;
                          const isFirstInGroup = !previousMessage || previousMessage.username !== action.username;
                          
                          const align = isP2 ? "flex-end" : isSystem ? "center" : "flex-start";
                          const bgColor = isP2 ? "var(--accent-soft)" : isSystem ? "transparent" : "var(--cyan-soft)";
                          const borderColor = isP2 ? "rgba(240, 178, 50, 0.2)" : isSystem ? "transparent" : "rgba(0, 212, 255, 0.15)";
                          const avatarContent = action.username ? action.username.slice(0, 2).toUpperCase() : "?";
                          
                          return (
                            <div key={action.sequence} style={{ display: "flex", flexDirection: "column", alignItems: align, width: "100%", marginTop: isFirstInGroup && !isSystem && index > 0 ? "16px" : "3px" }}>
                              {!isSystem && isFirstInGroup && (
                                <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginBottom: "4px", marginLeft: isP2 ? 0 : "40px", marginRight: isP2 ? "40px" : 0 }}>
                                  {action.username}
                                </div>
                              )}
                              <div style={{ display: "flex", flexDirection: isP2 ? "row-reverse" : "row", alignItems: "flex-end", gap: "8px", maxWidth: "90%" }}>
                                {!isSystem && (
                                  <div style={{ 
                                    width: "32px", height: "32px", borderRadius: "50%", 
                                    background: isP2 ? "rgba(240, 178, 50, 0.15)" : "rgba(0, 212, 255, 0.15)", 
                                    color: isP2 ? "var(--accent-light)" : "var(--cyan)",
                                    display: "flex", alignItems: "center", justifyContent: "center",
                                    fontSize: "0.8rem", fontWeight: 700,
                                    opacity: isFirstInGroup ? 1 : 0,
                                    flexShrink: 0
                                  }}>
                                    {avatarContent}
                                  </div>
                                )}
                                <div style={{ 
                                  background: bgColor, 
                                  color: "var(--text-1)",
                                  padding: isSystem ? "4px" : "8px 14px", 
                                  borderRadius: isSystem ? 0 : "16px", 
                                  borderBottomLeftRadius: isP1 && !isSystem ? "4px" : "16px",
                                  borderBottomRightRadius: isP2 && !isSystem ? "4px" : "16px",
                                  border: `1px solid ${borderColor}`,
                                  fontSize: "0.95rem",
                                  lineHeight: 1.4,
                                  textAlign: isSystem ? "center" : "left",
                                  fontStyle: isSystem ? "italic" : "normal",
                                  opacity: isSystem ? 0.6 : 1
                                }}>
                                  {isSystem && <span>[{action.seconds}s] {action.username ?? "System"}: </span>}
                                  {action.message}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
              </>
            );
          })()}

          <section className="table-section" id="interactive-replay-section">
            <div className="section-head">
              <h2>Interactive Replay</h2>
              <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                {data.replayUrl ? (
                  <a 
                    href={data.replayUrl} 
                    target="_blank" 
                    rel="noreferrer" 
                    className="btn-ghost btn-sm" 
                    style={{ display: "flex", alignItems: "center", gap: "6px" }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                    External Link
                  </a>
                ) : null}
                <button className="btn-ghost btn-sm" onClick={() => setShowActions((value) => !value)}>
                  {showActions ? "Hide" : "Show"} replay
                </button>
              </div>
            </div>
            {showActions ? (
              <div className="iframe-wrap" style={{ width: "100%", overflow: "hidden", borderRadius: "12px", border: "1px solid var(--border)", background: "#000", display: "flex", justifyContent: "center" }}>
                {data.replayUrl ? (
                  <iframe 
                    src={data.replayUrl} 
                    title="DuelingBook Replay"
                    style={{ width: "100%", height: "800px", border: "none", maxWidth: "1200px" }}
                    allowFullScreen
                  />
                ) : (
                  <div style={{ padding: "100px 20px", textAlign: "center", color: "var(--text-3)" }}>
                    <p>No interactive replay URL available for this duel.</p>
                  </div>
                )}
              </div>
            ) : (
              <p className="muted" style={{ padding: "10px 0", fontSize: "0.9rem" }}>Replay hidden. Expand to watch the interactive duel.</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

/* ── Admin Login Page ──────────────────────────────── */

function AdminLoginPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await fetchJson<{ ok: true }>("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      navigate("/matrix/archetypes");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-shell narrow">
      <SiteHeader admin />
      <section className="login-section">
        <h1>Admin Sign In</h1>
        <p className="muted">Use the shared admin password to manage archetype groups.</p>
        <form onSubmit={submit} className="login-form">
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error ? <p className="error-text">{error}</p> : null}
          <button disabled={loading || password.length === 0} type="submit">
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </section>
    </div>
  );
}

/* ── Admin Archetypes Page ─────────────────────────── */

function AdminArchetypesPage() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<ArchetypeGroup[]>([]);
  const [job, setJob] = useState<ReclassificationJob>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<CardSearchResult[]>([]);
  const [form, setForm] = useState({
    id: "",
    name: "",
    threshold: "3",
    enabled: true,
    coverCardName: "",
    cards: [] as string[],
  });

  const isEditing = form.id.length > 0;

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [groupData, jobData] = await Promise.all([
        fetchJson<ArchetypeGroup[]>("/api/admin/archetype-groups"),
        fetchJson<ReclassificationJob>("/api/admin/reclassification-jobs/latest"),
      ]);
      setGroups(groupData);
      setJob(jobData);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("401")) {
        navigate("/matrix/login");
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!search.trim()) {
      setSuggestions([]);
      return;
    }

    const handler = setTimeout(() => {
      fetchJson<CardSearchResult[]>(`/api/admin/cards?q=${encodeURIComponent(search.trim())}`)
        .then((result) => {
          if (!cancelled) {
            setSuggestions(result);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSuggestions([]);
          }
        });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(handler);
    };
  }, [search]);

  function resetForm() {
    setForm({
      id: "",
      name: "",
      threshold: "3",
      enabled: true,
      coverCardName: "",
      cards: [],
    });
    setSearch("");
    setSuggestions([]);
  }

  function editGroup(group: ArchetypeGroup) {
    setForm({
      id: String(group.id),
      name: group.name,
      threshold: String(group.threshold),
      enabled: group.enabled,
      coverCardName: group.coverCardName ?? "",
      cards: group.cards,
    });
  }

  async function saveGroup(event: FormEvent) {
    event.preventDefault();
    const body = {
      name: form.name.trim(),
      threshold: Number(form.threshold),
      enabled: form.enabled,
      coverCardName: form.coverCardName || null,
      cards: form.cards,
    };

    if (!body.name || body.cards.length === 0 || body.threshold < 1) {
      setError("Group name, threshold, and at least one card are required.");
      return;
    }

    if (body.threshold > body.cards.length) {
      setError("Threshold cannot exceed the number of cards in the group.");
      return;
    }

    setError(null);

    try {
      const url = isEditing ? `/api/admin/archetype-groups/${form.id}` : "/api/admin/archetype-groups";
      const method = isEditing ? "PUT" : "POST";
      await fetchJson(url, {
        method,
        body: JSON.stringify(body),
      });
      resetForm();
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteGroup(id: number) {
    try {
      await fetchJson(`/api/admin/archetype-groups/${id}`, { method: "DELETE" });
      if (form.id === String(id)) {
        resetForm();
      }
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleCard(name: string) {
    setForm((current) => {
      const exists = current.cards.includes(name);
      return {
        ...current,
        cards: exists ? current.cards.filter((card) => card !== name) : [...current.cards, name],
        coverCardName: exists ? (current.coverCardName === name ? "" : current.coverCardName) : (current.coverCardName || name),
      };
    });
  }

  function removeCard(name: string) {
    setForm((current) => ({
      ...current,
      cards: current.cards.filter((card) => card !== name),
      coverCardName: current.coverCardName === name ? "" : current.coverCardName,
    }));
  }

  return (
    <div className="page-shell">
      <SiteHeader admin />

      <header className="page-title">
        <h1>Archetype Groups</h1>
        <p>Manage deck identities and classification rules for replays.</p>
      </header>

      {error ? <p className="error-text">{error}</p> : null}
      {job ? (
        <section className="job-banner">
          <strong>Latest reclassification:</strong> {job.status} · started {formatTime(job.startedAt)}
          {job.completedAt ? ` · completed ${formatTime(job.completedAt)}` : ""}
        </section>
      ) : null}

      <div className="admin-grid">
        <section className="admin-panel">
          <h2>{isEditing ? "Edit group" : "Create new group"}</h2>
          <form className="editor-form" onSubmit={saveGroup}>
            <label>
              Group name
              <input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label>
              Unique-card threshold
              <input
                type="number"
                min="1"
                max={Math.max(1, form.cards.length)}
                value={form.threshold}
                onChange={(event) => setForm((current) => ({ ...current, threshold: event.target.value }))}
              />
              <span className="field-help">
                Player matches when their deck contains at least this many cards from the group.
              </span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
              />
              Enabled
            </label>
            <label>
              Add card
              <div 
                className="autocomplete-field" 
                style={{ position: "relative" }}
                onFocus={() => setSearchFocused(true)}
                onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setSearchFocused(false); }}
              >
                <input 
                  value={search} 
                  onChange={(event) => setSearch(event.target.value)} 
                  placeholder="Type a card name" 
                  style={{ paddingRight: "30px" }}
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setSuggestions([]);
                      setSearchFocused(true);
                    }}
                    style={{
                      position: "absolute",
                      right: "8px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      color: "var(--text-3)",
                      cursor: "pointer",
                      padding: "4px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                  </button>
                )}
                {searchFocused && (
                  <SuggestionMenu
                    suggestions={suggestions.map((card) => ({
                      value: card.name,
                      kind: "card",
                      imagePath: card.imagePath,
                      imageCroppedPath: card.imageCroppedPath,
                    }))}
                    onSelect={toggleCard}
                    selectedValues={new Set(form.cards)}
                  />
                )}
              </div>
            </label>
            <div className="selected-cards">
              {form.cards.map((card) => (
                <div className="selected-card" key={card}>
                  <span>{card}</span>
                  <button type="button" onClick={() => removeCard(card)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <label>
              Cover card
              <select value={form.coverCardName} onChange={(event) => setForm((current) => ({ ...current, coverCardName: event.target.value }))}>
                <option value="">Select cover card</option>
                {form.cards.map((card) => (
                  <option key={card} value={card}>
                    {card}
                  </option>
                ))}
              </select>
            </label>

            <div className="editor-actions">
              <button type="submit">{isEditing ? "Save changes" : "Create group"}</button>
              {isEditing ? (
                <button type="button" className="btn-ghost" onClick={resetForm}>
                  Cancel
                </button>
              ) : null}
            </div>
          </form>
        </section>

        <section className="admin-panel">
          <h2>Existing groups</h2>
          {loading ? <p className="muted">Loading groups...</p> : null}
          <div className="group-list">
            {groups.map((group) => (
              <article className="group-card" key={group.id}>
                <div className="group-card-head">
                  <div>
                    <h3>{group.name}</h3>
                    <p className="muted" style={{ fontSize: "0.8rem" }}>
                      Threshold {group.threshold} · {group.matchCount} matches
                    </p>
                  </div>
                  {group.coverImageCroppedPath ? <img src={group.coverImageCroppedPath} alt={group.name} className="group-cover" /> : null}
                </div>
                <p className="group-cards">{group.cards.join(", ")}</p>
                <div className="group-actions">
                  <button type="button" onClick={() => editGroup(group)} className="btn-ghost">
                    Edit
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => deleteGroup(group.id)}>
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ── App Router ────────────────────────────────────── */

type WorkerSessionRow = {
  accountUsername: string;
  state: string;
  currentDuelId: number | null;
  lastError: string | null;
  updatedAt: string;
};

function AdminWorkersPage() {
  const navigate = useNavigate();
  const [workers, setWorkers] = useState<WorkerSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchWorkers() {
      try {
        const data = await fetchJson<WorkerSessionRow[]>("/api/admin/workers");
        if (!cancelled) {
          setWorkers(data);
          setLoading(false);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("401")) {
            navigate("/matrix/login");
            return;
          }
          setError(message);
          setLoading(false);
        }
      }
    }

    void fetchWorkers();
    const interval = setInterval(() => {
      void fetchWorkers();
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [navigate]);

  return (
    <div className="page-shell">
      <SiteHeader admin />
      <header className="page-title">
        <h1>Workers Monitor</h1>
        <p>Live status of background watcher accounts.</p>
      </header>

      {error ? <p className="error-text">{error}</p> : null}
      
      <section className="table-section">
        {loading && workers.length === 0 ? (
          <p className="loading-text">Loading workers...</p>
        ) : workers.length === 0 ? (
          <p className="muted" style={{ padding: "20px" }}>No active worker sessions found.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>State</th>
                  <th>Current Duel</th>
                  <th>Last Updated</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {workers.map((worker) => (
                  <tr key={worker.accountUsername}>
                    <td style={{ fontWeight: 600 }}>{worker.accountUsername}</td>
                    <td>
                      <span className={`status-pill ${worker.state === "recording" ? "active" : worker.state === "stopped" ? "inactive" : ""}`} style={{
                        padding: "4px 8px",
                        borderRadius: "12px",
                        fontSize: "0.85rem",
                        background: worker.state === "recording" ? "rgba(74, 222, 128, 0.15)" : worker.state === "stopped" ? "rgba(239, 68, 68, 0.15)" : "rgba(255, 255, 255, 0.1)",
                        color: worker.state === "recording" ? "var(--success)" : worker.state === "stopped" ? "var(--error)" : "var(--text-1)",
                        fontWeight: 600
                      }}>
                        {worker.state}
                      </span>
                    </td>
                    <td>{worker.currentDuelId ? <a href={`https://www.duelingbook.com/replay?id=${worker.currentDuelId}`} target="_blank" rel="noreferrer">#{worker.currentDuelId}</a> : <span className="muted">None</span>}</td>
                    <td>{new Date(worker.updatedAt).toLocaleTimeString()}</td>
                    <td>{worker.lastError ? <span style={{ color: "var(--error)" }}>{worker.lastError}</span> : <span className="muted">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<ReplayListPage />} />
        <Route path="/replays/:duelId" element={<ReplayDetailPage />} />
        <Route path="/matrix" element={<Navigate to="/matrix/archetypes" replace />} />
        <Route path="/matrix/login" element={<AdminLoginPage />} />
        <Route path="/matrix/archetypes" element={<AdminArchetypesPage />} />
        <Route path="/matrix/workers" element={<AdminWorkersPage />} />
      </Routes>
      <Analytics />
    </>
  );
}
