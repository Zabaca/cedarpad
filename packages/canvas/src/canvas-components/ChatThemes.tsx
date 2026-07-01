import * as React from 'react';

// Inline tokeniser (bold, italic, code, links)
const INLINE_RE = /\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
function tokenise(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []; let pos = 0; INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > pos) out.push(text.slice(pos, m.index));
    const [full,bold,italic,code,label,href] = m as unknown as string[];
    if (bold)        out.push(<strong key={m.index}>{bold}</strong>);
    else if (italic) out.push(<em key={m.index}>{italic}</em>);
    else if (code)   out.push(<span key={m.index} style={{fontFamily:'monospace',opacity:0.85,background:'rgba(0,0,0,.25)',borderRadius:3,padding:'1px 4px',fontSize:'0.87em'}}>{code}</span>);
    else             out.push(<span key={m.index} style={{textDecoration:'underline',cursor:'pointer'}}>{label}</span>);
    pos = m.index + full!.length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}
function IL({ text }: { text: string }) { return <>{tokenise(text)}</>; }

// ---- theme definitions -------------------------------------------------------

type Theme = {
  name: string;
  desc: string;
  bg: string;        // card background
  panel: string;     // header + input area
  border: string;
  text: string;
  muted: string;
  accent: string;
  userBubble: string;
  userText: string;
  agentBubble: string;
  agentBorder: string;
  inputBg: string;
  dot: string;
  tableTh: string;
  tableRowAlt: string;
  font: string;
  radius: number;
}

const THEMES: Theme[] = [
  {
    name: 'Obsidian',
    desc: 'Current — deep navy dark',
    bg: '#171a21', panel: '#12151b', border: '#262b36',
    text: '#e6e9ef', muted: '#8b93a3', accent: '#4f7cff',
    userBubble: '#2a3550', userText: '#e6e9ef',
    agentBubble: '#11141a', agentBorder: '#262b36',
    inputBg: '#0d1017', dot: '#3ddc84',
    tableTh: '#1a1e29', tableRowAlt: '#0f1218',
    font: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
    radius: 12,
  },
  {
    name: 'Terminal',
    desc: 'Pure black · green accent',
    bg: '#0a0a0a', panel: '#050505', border: '#1a2a1a',
    text: '#d8f0d8', muted: '#4a7a52', accent: '#00d060',
    userBubble: '#0a1f0a', userText: '#d8f0d8',
    agentBubble: '#030303', agentBorder: '#1a2a1a',
    inputBg: '#000000', dot: '#00d060',
    tableTh: '#0d1f0d', tableRowAlt: '#060d06',
    font: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
    radius: 6,
  },
  {
    name: 'Paper',
    desc: 'Light mode · warm ivory',
    bg: '#ffffff', panel: '#f7f4ef', border: '#e0dbd4',
    text: '#2a2520', muted: '#7a7268', accent: '#3d5bd4',
    userBubble: '#dce5f7', userText: '#1a2240',
    agentBubble: '#f5f3ef', agentBorder: '#e0dbd4',
    inputBg: '#fafaf8', dot: '#22c55e',
    tableTh: '#eeeae3', tableRowAlt: '#f7f5f1',
    font: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
    radius: 14,
  },
  {
    name: 'Dusk',
    desc: 'Deep violet dark · lavender',
    bg: '#131020', panel: '#0f0c1a', border: '#2a2448',
    text: '#ddd8f2', muted: '#7a7299', accent: '#a855f7',
    userBubble: '#1e1840', userText: '#ddd8f2',
    agentBubble: '#0d0b16', agentBorder: '#2a2448',
    inputBg: '#09070f', dot: '#a855f7',
    tableTh: '#1a1630', tableRowAlt: '#0f0d1e',
    font: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
    radius: 16,
  },
  {
    name: 'Amber',
    desc: 'Warm charcoal · gold',
    bg: '#1c1a0f', panel: '#161408', border: '#3a3318',
    text: '#f0e8cc', muted: '#897a52', accent: '#d4a017',
    userBubble: '#2e280e', userText: '#f0e8cc',
    agentBubble: '#110f06', agentBorder: '#3a3318',
    inputBg: '#0e0c04', dot: '#d4a017',
    tableTh: '#242110', tableRowAlt: '#151208',
    font: '"Georgia", ui-serif, serif',
    radius: 10,
  },
];

// ---- sample content ---------------------------------------------------------

const USER_MSG = 'what\'s the current whoop device price and subscription';
const AGENT_LINES = [
  { type: 'p', text: '**WHOOP (U.S., 2026)** — device included with subscription:' },
  { type: 'table', rows: [['Plan','Price/yr'],['WHOOP One','$199'],['WHOOP Peak','$239'],['WHOOP Life','$359']] },
  { type: 'p', text: 'Current hardware is the **WHOOP 5.0**, FDA-cleared. Subscribers with 12+ months can upgrade free.' },
  { type: 'list', items: ['[WHOOP tests device as separate purchase](x)','[Is WHOOP Worth the Price?](x)'] },
];

// ---- mini markdown renderer --------------------------------------------------

function MiniMd({ lines, th, rowAlt, accent, border }: {
  lines: typeof AGENT_LINES; th: string; rowAlt: string; accent: string; border: string
}) {
  return (
    <div style={{fontSize:'inherit',lineHeight:1.55}}>
      {lines.map((b,i) => {
        if (b.type === 'p') return (
          <p key={i} style={{margin:'0.35em 0'}}><IL text={b.text!} /></p>
        );
        if (b.type === 'table') return (
          <div key={i} style={{overflowX:'auto',margin:'0.4em 0'}}>
            <table style={{borderCollapse:'collapse',width:'100%',fontSize:'0.9em'}}>
              <thead><tr>{b.rows![0]!.map((c,ci)=>(
                <th key={ci} style={{padding:'3px 8px',border:`1px solid ${border}`,background:th,fontWeight:600,textAlign:'left'}}>{c}</th>
              ))}</tr></thead>
              <tbody>{b.rows!.slice(1).map((row,ri)=>(
                <tr key={ri} style={{background:ri%2===1?rowAlt:'transparent'}}>{row.map((c,ci)=>(
                  <td key={ci} style={{padding:'3px 8px',border:`1px solid ${border}`}}>{c}</td>
                ))}</tr>
              ))}</tbody>
            </table>
          </div>
        );
        if (b.type === 'list') return (
          <ul key={i} style={{margin:'0.35em 0',paddingLeft:'1.2em'}}>
            {b.items!.map((item,ii)=>(
              <li key={ii} style={{margin:'0.1em 0'}}>
                <span style={{color:accent,textDecoration:'underline',cursor:'pointer'}}><IL text={item} /></span>
              </li>
            ))}
          </ul>
        );
        return null;
      })}
    </div>
  );
}

// ---- single theme card -------------------------------------------------------

function ChatCard({ t }: { t: Theme }) {
  const r = t.radius;
  return (
    <div style={{
      width: 280,
      display:'flex',
      flexDirection:'column',
      fontFamily: t.font,
      fontSize: 12,
      color: t.text,
      background: t.bg,
      borderRadius: r,
      border: `1px solid ${t.border}`,
      boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
      overflow:'hidden',
      flexShrink:0,
    }}>
      {/* header */}
      <div style={{
        display:'flex', alignItems:'center', gap:7,
        padding:'9px 12px',
        background: t.panel,
        borderBottom: `1px solid ${t.border}`,
      }}>
        <div style={{width:8,height:8,borderRadius:'50%',background:t.dot,boxShadow:`0 0 7px ${t.dot}aa`,flexShrink:0}} />
        <span style={{fontWeight:700,fontSize:12,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{t.name}</span>
        <span style={{marginLeft:'auto',color:t.muted,fontSize:10,fontStyle:'italic',fontFamily:'ui-sans-serif,sans-serif'}}>{t.desc}</span>
      </div>

      {/* log */}
      <div style={{flex:1,overflowY:'auto',padding:'12px 10px',display:'flex',flexDirection:'column',gap:8,minHeight:280,maxHeight:360}}>
        {/* user bubble */}
        <div style={{
          alignSelf:'flex-end', maxWidth:'85%',
          background: t.userBubble, color: t.userText,
          borderRadius: r, borderBottomRightRadius: 4,
          padding:'7px 10px', fontSize:12, lineHeight:1.5,
        }}>
          {USER_MSG}
        </div>

        {/* tool chip */}
        <div style={{
          alignSelf:'flex-start',
          fontFamily:'ui-monospace,monospace', fontSize:10.5,
          color:t.muted, background:t.inputBg,
          border:`1px solid ${t.border}`,
          borderRadius:5, padding:'2px 7px',
        }}>
          WebSearch
        </div>

        {/* agent bubble */}
        <div style={{
          alignSelf:'flex-start', maxWidth:'95%',
          background: t.agentBubble,
          border: `1px solid ${t.agentBorder}`,
          borderRadius: r, borderBottomLeftRadius: 4,
          padding:'8px 10px', fontSize:12, lineHeight:1.5,
        }}>
          <MiniMd lines={AGENT_LINES} th={t.tableTh} rowAlt={t.tableRowAlt} accent={t.accent} border={t.border} />
        </div>
      </div>

      {/* input */}
      <div style={{
        display:'flex', gap:7, padding:'9px 10px',
        borderTop:`1px solid ${t.border}`,
        background: t.panel,
      }}>
        <div style={{
          flex:1, background:t.inputBg,
          border:`1px solid ${t.border}`,
          borderRadius:7, padding:'7px 10px',
          fontSize:11.5, color:t.muted,
        }}>
          Message the agent…
        </div>
        <div style={{
          background:t.accent, color:'#fff',
          borderRadius:7, padding:'0 12px',
          fontSize:11.5, fontWeight:700,
          display:'flex', alignItems:'center',
          fontFamily:'ui-sans-serif,sans-serif',
        }}>
          Send
        </div>
      </div>
    </div>
  );
}

// ---- root -------------------------------------------------------------------

export default function ChatThemes() {
  return (
    <div style={{
      display:'flex', gap:20, padding:24, alignItems:'flex-start',
      width:'100%', height:'100%', boxSizing:'border-box',
      background:'#08090c', overflowX:'auto', overflowY:'auto',
    }}>
      {THEMES.map(t => <ChatCard key={t.name} t={t} />)}
    </div>
  );
}
