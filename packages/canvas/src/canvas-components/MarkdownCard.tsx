// Generic markdown card — renders any `markdown` prop through the same parser as chat bubbles.
// Pass `title` for an optional header label.

import * as React from 'react';

const INLINE_RE = /\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;

function tokenise(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []; let pos = 0; INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > pos) out.push(text.slice(pos, m.index));
    const [full,bold,italic,code,label,href] = m as unknown as string[];
    if (bold)        out.push(<strong key={m.index}><IL text={bold!}/></strong>);
    else if (italic) out.push(<em key={m.index}><IL text={italic!}/></em>);
    else if (code)   out.push(<code key={m.index} style={{background:'#0b0d12',border:'1px solid #2a2e3d',borderRadius:3,padding:'1px 5px',fontFamily:'monospace',fontSize:'0.87em'}}>{code}</code>);
    else             out.push(<a key={m.index} href={href??'#'} target="_blank" rel="noreferrer" style={{color:'#4a9eff'}}>{label}</a>);
    pos = m.index + full!.length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}
function IL({ text }: { text: string }) { return <>{tokenise(text)}</>; }

type Block={t:'h';level:number;text:string}|{t:'fence';code:string}|{t:'table';rows:string[][]}|{t:'list';ordered:boolean;items:string[]}|{t:'hr'}|{t:'para';lines:string[]};
const H=/^(#{1,6})\s+(.+)$/,HR=/^[-*_]{3,}$/,OL=/^\d+\.\s+/,UL=/^[-*+]\s+/,FC=/^```/;

function parse(md: string): Block[] {
  const lines=md.split('\n'),blocks: Block[]=[]; let i=0;
  while(i<lines.length){
    const line=lines[i]??'',t=line.trim();
    if(!t){i++;continue;}
    const hm=H.exec(line);
    if(hm){blocks.push({t:'h',level:hm[1]!.length,text:hm[2]??''});i++;continue;}
    if(HR.test(t)){blocks.push({t:'hr'});i++;continue;}
    if(FC.test(line)){const code:string[]=[]; i++;
      while(i<lines.length&&!FC.test(lines[i]??'')){code.push(lines[i]??'');i++;} i++;
      blocks.push({t:'fence',code:code.join('\n')});continue;}
    if(line.startsWith('|')){const raw:string[]=[];
      while(i<lines.length&&(lines[i]??'').startsWith('|')){raw.push(lines[i]??'');i++;}
      const rows=raw.filter(l=>/[^|\s\-:]/.test(l)).map(l=>l.replace(/^\||\|$/g,'').split('|').map(c=>c.trim()));
      if(rows.length)blocks.push({t:'table',rows});continue;}
    if(OL.test(line)){const items:string[]=[];
      while(i<lines.length&&OL.test(lines[i]??'')){items.push((lines[i]??'').replace(OL,''));i++;}
      blocks.push({t:'list',ordered:true,items});continue;}
    if(UL.test(line)){const items:string[]=[];
      while(i<lines.length&&UL.test(lines[i]??'')){items.push((lines[i]??'').replace(UL,''));i++;}
      blocks.push({t:'list',ordered:false,items});continue;}
    const para:string[]=[];
    while(i<lines.length){const c=lines[i]??'';
      if(!c.trim()||H.test(c)||FC.test(c)||c.startsWith('|')||OL.test(c)||UL.test(c)||HR.test(c.trim()))break;
      para.push(c);i++;}
    if(para.length)blocks.push({t:'para',lines:para});
  }
  return blocks;
}

export function tocEntries(md: string): Array<{ level: number; text: string; index: number }> {
  return parse(md).reduce<Array<{ level: number; text: string; index: number }>>((out, b, index) => {
    if (b.t === 'h') out.push({ level: b.level, text: b.text, index });
    return out;
  }, []);
}

const LINE='#2a2e3d', TH='#1a1e29';

function renderBlock(b: Block, idx: number): React.ReactNode {
  switch(b.t){
    case 'h': return React.createElement(`h${b.level}`,{key:idx,style:{margin:'0.5em 0 0.2em',fontWeight:700,fontSize:'1em',color:'#e2e4e9',lineHeight:1.3}},<IL text={b.text}/>);
    case 'fence': return <pre key={idx} style={{background:'#0b0d12',border:`1px solid ${LINE}`,borderRadius:6,padding:'10px 12px',margin:'0.5em 0',fontFamily:'monospace',fontSize:'0.87em',overflowX:'auto',color:'#a3e6cb',lineHeight:1.5}}><code>{b.code}</code></pre>;
    case 'table':{const[header,...body]=b.rows;return(
      <div key={idx} style={{overflowX:'auto',margin:'0.5em 0'}}>
        <table style={{borderCollapse:'collapse',width:'100%',fontSize:'0.91em'}}>
          {header&&<thead><tr>{header.map((c,ci)=><th key={ci} style={{padding:'4px 10px',border:`1px solid ${LINE}`,background:TH,fontWeight:600,textAlign:'left'}}><IL text={c}/></th>)}</tr></thead>}
          <tbody>{body.map((row,ri)=><tr key={ri} style={{background:ri%2===1?'#0f1218':'transparent'}}>{row.map((c,ci)=><td key={ci} style={{padding:'4px 10px',border:`1px solid ${LINE}`}}><IL text={c}/></td>)}</tr>)}</tbody>
        </table>
      </div>);}
    case 'list': return b.ordered
      ?<ol key={idx} style={{margin:'0.35em 0',paddingLeft:'1.4em'}}>{b.items.map((item,ii)=><li key={ii} style={{margin:'0.15em 0'}}><IL text={item}/></li>)}</ol>
      :<ul key={idx} style={{margin:'0.35em 0',paddingLeft:'1.4em'}}>{b.items.map((item,ii)=><li key={ii} style={{margin:'0.15em 0'}}><IL text={item}/></li>)}</ul>;
    case 'hr': return <hr key={idx} style={{border:'none',borderTop:`1px solid ${LINE}`,margin:'0.6em 0'}}/>;
    case 'para': return <p key={idx} style={{margin:'0.4em 0'}}>{b.lines.map((line,li)=><React.Fragment key={li}>{li>0&&<br/>}<IL text={line}/></React.Fragment>)}</p>;
  }
}

export default function MarkdownCard({ title, markdown = '', accent = '#4a9eff' }: { title?: string; markdown?: string; accent?: string }) {
  const blocks = React.useMemo(() => parse(markdown), [markdown]);
  const toc = React.useMemo(() => tocEntries(markdown), [markdown]);
  const showToggle = toc.length >= 2;
  const rootRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const headingRefs = React.useRef(new Map<number, HTMLElement>());
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (showToggle && (rootRef.current?.offsetWidth ?? 0) >= 520) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scrollToHeading = (index: number) => {
    headingRefs.current.get(index)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return (
    <div ref={rootRef} style={{
      width:'100%', height:'100%', boxSizing:'border-box',
      background:'#11141a', border:`1px solid ${LINE}`, borderRadius:12,
      color:'#c9cdd6', fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      fontSize:13, lineHeight:1.55, display:'flex', flexDirection:'column', overflow:'hidden',
      position:'relative',
    }}>
      {title && (
        <div style={{padding:'8px 14px',borderBottom:`1px solid ${LINE}`,background:'#0d1017',fontSize:11,fontWeight:600,color:accent,letterSpacing:'0.06em',textTransform:'uppercase',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <span>{title}</span>
          {showToggle && <TocToggle open={open} onClick={() => setOpen(o => !o)} accent={accent}/>}
        </div>
      )}
      {!title && showToggle && (
        <div style={{position:'absolute',top:6,right:6,zIndex:1}}>
          <TocToggle open={open} onClick={() => setOpen(o => !o)} accent={accent}/>
        </div>
      )}
      <div style={{flex:1,display:'flex',minHeight:0}}>
        {showToggle && open && (
          <div style={{width:140,flexShrink:0,overflowY:'auto',borderRight:`1px solid ${LINE}`,padding:'10px 8px'}}>
            {toc.map(entry => (
              <div
                key={entry.index}
                onClick={() => scrollToHeading(entry.index)}
                style={{
                  fontSize:11,color:'#7a7f8c',cursor:'pointer',paddingLeft:(entry.level-1)*10,
                  whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',margin:'3px 0',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = accent; }}
                onMouseLeave={e => { e.currentTarget.style.color = '#7a7f8c'; }}
              >
                {entry.text}
              </div>
            ))}
          </div>
        )}
        <div ref={scrollRef} style={{flex:1,overflowY:'auto',padding:'12px 14px',minWidth:0}}>
          {blocks.map((b, idx) => b.t === 'h'
            ? React.cloneElement(renderBlock(b, idx) as React.ReactElement, { ref: (el: HTMLElement | null) => {
                if (el) headingRefs.current.set(idx, el); else headingRefs.current.delete(idx);
              } })
            : renderBlock(b, idx))}
        </div>
      </div>
    </div>
  );
}

function TocToggle({ open, onClick, accent }: { open: boolean; onClick: () => void; accent: string }) {
  return (
    <button
      onClick={onClick}
      title={open ? 'Hide table of contents' : 'Show table of contents'}
      style={{
        background:'transparent',border:`1px solid ${LINE}`,borderRadius:4,color:open?accent:'#7a7f8c',
        cursor:'pointer',fontSize:11,lineHeight:1,padding:'3px 6px',flexShrink:0,
      }}
    >
      ☰
    </button>
  );
}
