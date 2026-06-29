
export default function ResumeKhoa() {
  const colors = {
    navy: '#1a2e4a',
    accent: '#2563eb',
    lightBg: '#f0f4f8',
    border: '#cbd5e1',
    text: '#1e293b',
    muted: '#64748b',
    white: '#ffffff',
  };

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
      }}>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: colors.accent,
        }}>{title}</span>
        <div style={{ flex: 1, height: 1, background: colors.accent, opacity: 0.3 }} />
      </div>
      {children}
    </div>
  );

  const Job = ({
    title, company, location, period, bullets,
  }: {
    title: string; company: string; location: string; period: string; bullets: string[];
  }) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: colors.text }}>{title}</span>
        <span style={{ fontSize: 9.5, color: colors.muted }}>{period}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: colors.accent, fontWeight: 600 }}>{company}</span>
        <span style={{ fontSize: 9.5, color: colors.muted }}>{location}</span>
      </div>
      <ul style={{ margin: 0, paddingLeft: 14, listStyle: 'disc' }}>
        {bullets.map((b, i) => (
          <li key={i} style={{ fontSize: 9.5, color: colors.text, lineHeight: 1.5, marginBottom: 2 }}>{b}</li>
        ))}
      </ul>
    </div>
  );

  const Pill = ({ label }: { label: string }) => (
    <span style={{
      display: 'inline-block', padding: '2px 8px',
      background: colors.lightBg, border: `1px solid ${colors.border}`,
      borderRadius: 99, fontSize: 9, color: colors.text, margin: '2px 3px 2px 0',
    }}>{label}</span>
  );

  const Credential = ({ name, issuer, year }: { name: string; issuer: string; year: string }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
      <div>
        <span style={{ fontSize: 10, fontWeight: 700, color: colors.text }}>{name}</span>
        <span style={{ fontSize: 9.5, color: colors.muted }}> · {issuer}</span>
      </div>
      <span style={{ fontSize: 9.5, color: colors.muted }}>{year}</span>
    </div>
  );

  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'hidden',
      fontFamily: "'Inter', 'Helvetica Neue', sans-serif",
      background: colors.white, display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        background: colors.navy, color: colors.white, padding: '18px 22px 14px',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 2 }}>
          Khoa Truong
        </div>
        <div style={{ fontSize: 12, fontWeight: 500, color: '#93c5fd', marginBottom: 8 }}>
          FCAS · CPCU · Fellow, Casualty Actuarial Society
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {[
            { icon: '📍', label: 'Washington, DC Metro Area' },
            { icon: '🏢', label: 'Central Insurance · Van Wert, OH' },
            { icon: '🎓', label: 'USC 2017 · International Relations minor' },
            { icon: '🌐', label: 'English · Vietnamese (native)' },
          ].map((item, i) => (
            <span key={i} style={{ fontSize: 9.5, color: '#bfdbfe', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span>{item.icon}</span>{item.label}
            </span>
          ))}
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left column */}
        <div style={{ width: 220, flexShrink: 0, padding: '14px 14px 14px 18px', borderRight: `1px solid ${colors.border}`, overflow: 'auto' }}>
          <Section title="Credentials">
            <Credential name="FCAS" issuer="CAS" year="Jul 2024" />
            <Credential name="CPCU" issuer="The Institutes" year="Aug 2024" />
            <Credential name="ACAS" issuer="CAS" year="Nov 2022" />
          </Section>

          <Section title="Exams Passed">
            {['Exam P', 'Exam FM', 'Exam IFM', 'MAS-I', 'MAS-II', 'Exam 5', 'Exam 6', 'Exam 7', 'Exam 8', 'Exam 9'].map(e => (
              <div key={e} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ color: '#22c55e', fontSize: 9 }}>✓</span>
                <span style={{ fontSize: 9.5, color: colors.text }}>{e}</span>
              </div>
            ))}
          </Section>

          <Section title="Education">
            <div style={{ fontSize: 10, fontWeight: 700, color: colors.text }}>University of Southern California</div>
            <div style={{ fontSize: 9.5, color: colors.muted, marginBottom: 2 }}>2013 – 2017</div>
            <div style={{ fontSize: 9.5, color: colors.text }}>GPA 3.56 / 4.0</div>
            <div style={{ fontSize: 9.5, color: colors.text }}>Minor: International Relations</div>
          </Section>

          <Section title="Skills">
            {['Pricing & Reserving', 'Loss Development', 'Predictive Modeling', 'Rate Indication', 'Real-time KPI Design', 'Actuarial Communication', 'Python / R / Excel', 'P&C Insurance', 'Auto / Commercial Lines', 'Data Storytelling'].map(s => (
              <Pill key={s} label={s} />
            ))}
          </Section>

          <Section title="Languages">
            <div style={{ fontSize: 9.5, color: colors.text, marginBottom: 3 }}>English <span style={{ color: colors.muted }}>(native)</span></div>
            <div style={{ fontSize: 9.5, color: colors.text }}>Vietnamese <span style={{ color: colors.muted }}>(native)</span></div>
          </Section>
        </div>

        {/* Right column */}
        <div style={{ flex: 1, padding: '14px 18px', overflow: 'auto' }}>
          <Section title="Professional Summary">
            <p style={{ fontSize: 10, color: colors.text, lineHeight: 1.6, margin: 0 }}>
              Fellowship-level actuary (FCAS, CPCU) with deep expertise in P&C pricing,
              reserving, and real-time loss monitoring. Known for translating complex actuarial
              analyses into actionable decisions through clear communication and storytelling.
              Broad career spanning Los Angeles, New York, London, Omaha, and the DC metro area,
              with experience across personal auto, commercial lines, and specialty coverages.
            </p>
          </Section>

          <Section title="Experience">
            <Job
              title="Property & Casualty Actuary"
              company="Central Insurance"
              location="Van Wert, OH (remote)"
              period="2023 – Present"
              bullets={[
                'Lead pricing analyses for personal and commercial auto lines, modeling tariff-driven inflation effects on frequency and severity',
                'Designed real-time KPI dashboards minimally exposed to development, enabling live views of loss trends during periods of high uncertainty (post-pandemic, post-tariff)',
                'Advocated for accelerated indication cycles — shifting from semi-annual to quarterly — to incorporate emerging data and reduce lag in rate responses',
                'Presented findings to underwriting and executive leadership, translating actuarial indications into strategic rate action recommendations',
              ]}
            />
            <Job
              title="Associate Actuary"
              company="Prior Employer · Specialty / Commercial Lines"
              location="New York, NY · London, UK"
              period="2020 – 2023"
              bullets={[
                'Completed ACAS fellowship pathway while leading reserving analyses for specialty commercial programs',
                'Built loss development frameworks for long-tail lines; identified early signals of severity trend changes ahead of quarterly reserve reviews',
                'Collaborated with London market underwriters on international book performance, bridging US and Lloyd\'s reserving conventions',
              ]}
            />
            <Job
              title="Actuarial Analyst"
              company="Prior Employer · Personal Lines"
              location="Los Angeles, CA · Greater Omaha"
              period="2017 – 2020"
              bullets={[
                'Supported pricing, filing, and rate-level adequacy work for personal auto and homeowners across multiple states',
                'Passed Exams P, FM, IFM, MAS-I, MAS-II, 5, 6, and 7 while working full-time — completing the preliminary and upper-level CAS exam pathway',
                'Built competitive analysis models tracking market rate changes by territory and coverage',
              ]}
            />
          </Section>

          <Section title="Thought Leadership">
            <div style={{ fontSize: 9.5, color: colors.text, lineHeight: 1.6 }}>
              Published actuarial commentary on tariff-driven auto insurance inflation, arguing that
              real-time KPIs outperform traditional loss development during system disruption — and
              that actuary effectiveness is ultimately measured by the quality of decisions influenced,
              not analyses produced.
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
