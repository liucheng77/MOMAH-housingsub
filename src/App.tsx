import { useState, useMemo } from 'react';
import { 
  BarChart3, 
  FileText, 
  Cpu,
  ArrowUpRight,
  TrendingDown,
  AlertCircle,
  Play,
  ChevronDown,
  Home,
  Globe,
  User,
  Terminal,
  CheckCircle2
} from 'lucide-react';
import { 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  Area,
  ComposedChart,
  Line
} from 'recharts';

const MetricCard = ({ title, value, subValue, trend, trendType, highlight = false }: { title: string, value: string, subValue: string, trend: string, trendType: 'up' | 'down', highlight?: boolean }) => (
  <div className={`bg-white border p-6 rounded-2xl shadow-pc-sm transition-all duration-500 ${
    highlight ? 'border-[#1C8354] ring-2 ring-[#1C8354]/20 scale-[1.02]' : 'border-neutral-200 hover:shadow-pc-md'
  }`}>
    <div className="flex justify-between items-start mb-4">
      <h3 className="pc-text-sm font-semibold text-neutral-600">{title}</h3>
      <div className={`px-2 py-1 rounded text-[12px] font-bold flex items-center gap-1 ${
        trendType === 'down' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'
      }`}>
        {trendType === 'down' ? <TrendingDown size={12} /> : <ArrowUpRight size={12} />}
        {trend}
      </div>
    </div>
    <div className="space-y-1">
      <div className={`pc-display-sm font-bold transition-colors duration-500 ${highlight ? 'text-[#1C8354]' : 'text-neutral-900'}`}>
        {value}
      </div>
      <div className="pc-text-xs text-neutral-500 font-medium">{subValue}</div>
    </div>
  </div>
);

type SimStage = 'idle' | 'policy' | 'optimization' | 'monitoring' | 'forecasting' | 'completed';

const App = () => {
  const [threshold, setThreshold] = useState(10000);
  const [simStage, setSimStage] = useState<SimStage>('idle');
  const [logs, setLogs] = useState<{msg: string, type: 'info' | 'success' | 'agent'}[]>([]);

  // Subsidy specific mock data
  const MONTHLY_TREND = [
    { month: 'Jan', expenditure: 280, fgIndex: 12.1 },
    { month: 'Feb', expenditure: 295, fgIndex: 12.5 },
    { month: 'Mar', expenditure: 285, fgIndex: 13.0 },
    { month: 'Apr', expenditure: 310, fgIndex: 13.8 },
    { month: 'May', expenditure: 325, fgIndex: 14.5 },
    { month: 'Jun', expenditure: 300, fgIndex: 15.2 },
  ];

  const estimatedSavings = useMemo(() => {
    const base = 1.37;
    const factor = (threshold - 8000) / 4000;
    return (base + factor * 2.03).toFixed(2);
  }, [threshold]);

  const fairnessGap = useMemo(() => {
    return (15 - (threshold / 2000)).toFixed(1);
  }, [threshold]);

  const AGENTS = [
    { id: 'policy', name: 'Policy-Alignment-Agent', task: 'Validating threshold compliance', status: simStage === 'policy' ? 'Processing' : (['optimization', 'monitoring', 'forecasting', 'completed'].includes(simStage) ? 'Completed' : 'Standby'), load: simStage === 'policy' ? 85 : 0 },
    { id: 'optimization', name: 'Subsidy-Optimization-Agent', task: 'Recalculating allocation matrix', status: simStage === 'optimization' ? 'Processing' : (['monitoring', 'forecasting', 'completed'].includes(simStage) ? 'Completed' : 'Standby'), load: simStage === 'optimization' ? 92 : 0 },
    { id: 'monitoring', name: 'Fairness-Monitor-Agent', task: 'Tracking FG Index deviation', status: simStage === 'monitoring' ? 'Processing' : (['forecasting', 'completed'].includes(simStage) ? 'Completed' : 'Standby'), load: simStage === 'monitoring' ? 64 : 0 },
    { id: 'forecasting', name: 'Demand-Forecast-Agent', task: 'Predicting Q3 demand trends', status: simStage === 'forecasting' ? 'Processing' : (simStage === 'completed' ? 'Completed' : 'Standby'), load: simStage === 'forecasting' ? 45 : 0 },
  ];

  const addLog = (msg: string, type: 'info' | 'success' | 'agent' = 'info') => {
    setLogs(prev => [...prev.slice(-4), { msg, type }]);
  };

  const runSimulation = async () => {
    setSimStage('policy');
    setLogs([]);
    addLog('Initiating Multi-Agent Orchestration...', 'info');
    
    await new Promise(r => setTimeout(r, 1200));
    addLog('Policy-Alignment-Agent: Threshold validated (Compliance OK)', 'agent');
    setSimStage('optimization');
    
    await new Promise(r => setTimeout(r, 1500));
    addLog('Subsidy-Optimization-Agent: Recalculated 142k records', 'agent');
    addLog(`Projected Savings updated to ${estimatedSavings}B SAR`, 'success');
    setSimStage('monitoring');
    
    await new Promise(r => setTimeout(r, 1200));
    addLog('Fairness-Monitor-Agent: FG Index impact analysis complete', 'agent');
    addLog(`Fairness Gap adjusted to ${fairnessGap}%`, 'success');
    setSimStage('forecasting');
    
    await new Promise(r => setTimeout(r, 1000));
    addLog('Demand-Forecast-Agent: Q3 projections synchronized', 'agent');
    
    setSimStage('completed');
    addLog('Orchestration Cycle Complete. All policies applied.', 'success');
    
    setTimeout(() => {
      if (simStage === 'completed') setSimStage('idle');
    }, 5000);
  };

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-800 font-sans flex flex-col">
      {/* Main Header */}
      <header className="bg-white border-b border-neutral-200 sticky top-0 z-10 shadow-pc-sm">
        <div className="max-w-[1400px] mx-auto px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-12">
            {/* Logo Area */}
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full border-2 border-[#1C8354] flex items-center justify-center overflow-hidden bg-white">
                <Home className="text-[#1C8354]" size={24} />
              </div>
              <div className="flex flex-col">
                <span className="text-[#1C8354] font-bold text-xl leading-none">Housing</span>
                <span className="text-neutral-500 text-xs">Subsidy</span>
              </div>
            </div>

            {/* Navigation - Content Aligned with BRD */}
            <nav className="hidden lg:flex items-center gap-8 font-medium text-neutral-700">
              <div className="flex items-center gap-1 cursor-pointer hover:text-[#1C8354] transition-colors text-[#1C8354] border-b-2 border-[#1C8354] pb-1">
                Allocation Dashboard <ChevronDown size={16} />
              </div>
              <div className="flex items-center gap-1 cursor-pointer hover:text-[#1C8354] transition-colors pb-1">
                Policy Simulation <ChevronDown size={16} />
              </div>
              <div className="flex items-center gap-1 cursor-pointer hover:text-[#1C8354] transition-colors pb-1">
                Fairness Monitoring <ChevronDown size={16} />
              </div>
              <div className="flex items-center gap-1 cursor-pointer hover:text-[#1C8354] transition-colors pb-1">
                Demand Forecast <ChevronDown size={16} />
              </div>
            </nav>
          </div>

          {/* Right Actions */}
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 cursor-pointer text-neutral-600 hover:text-[#1C8354]">
              <Globe size={20} />
              <span className="font-bold">العربية</span>
            </div>
            <div className="flex items-center gap-2 cursor-pointer text-neutral-600 hover:text-[#1C8354]">
              <User size={20} />
              <span className="font-bold">Agency Analyst</span>
            </div>
          </div>
        </div>
      </header>

      {/* Page Content */}
      <main className="flex-1 w-full max-w-[1400px] mx-auto px-8 py-8">
        
        {/* Page Title / Hero */}
        <div className="mb-8">
          <div className="flex items-center gap-2 text-sm text-[#1C8354] font-bold mb-2">
            <Home size={16} />
            <span>Home</span>
            <span className="text-neutral-400">/</span>
            <span>Services</span>
            <span className="text-neutral-400">/</span>
            <span>Housing Subsidy Allocation</span>
          </div>
          <div className="flex justify-between items-end">
            <div>
              <h1 className="text-4xl font-bold text-neutral-900 mb-2">Dynamic Allocation Engine</h1>
              <p className="text-lg text-neutral-500">Real-time optimization and fairness monitoring for housing subsidies across regions.</p>
            </div>
            <div className="flex gap-3">
               <button className="px-6 py-2.5 bg-white border border-neutral-300 text-neutral-700 rounded-lg text-sm font-bold hover:bg-neutral-50 transition-all">
                Export Audit Trail
              </button>
              <button 
                onClick={runSimulation}
                disabled={simStage !== 'idle' && simStage !== 'completed'}
                className="px-6 py-2.5 bg-[#1C8354] text-white rounded-lg text-sm font-bold hover:bg-[#166943] transition-all flex items-center gap-2"
              >
                <Play size={16} fill="white" />
                New Scenario
              </button>
            </div>
          </div>
        </div>

        {/* KPI Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <MetricCard 
            title="Projected Savings" 
            value={`SAR ${estimatedSavings}B`} 
            subValue="Target: 3.4B SAR"
            trend="-12.5%" 
            trendType="down"
            highlight={simStage === 'optimization'}
          />
          <MetricCard 
            title="Fairness Gap (FG)" 
            value={`${fairnessGap}%`} 
            subValue="Target: < 15.0%"
            trend="-5.2%" 
            trendType="down"
            highlight={simStage === 'monitoring'}
          />
          <MetricCard 
            title="Targeted Beneficiaries" 
            value="850K" 
            subValue="Income < 10,000 SAR"
            trend="+4.1%" 
            trendType="up"
            highlight={simStage === 'policy'}
          />
          <MetricCard 
            title="Allocation Efficiency" 
            value="94.2%" 
            subValue="AI Optimization Score"
            trend="+1.8%" 
            trendType="up"
            highlight={simStage === 'forecasting'}
          />
        </div>

        {/* Main Section */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-8">
          {/* Chart Area */}
          <div className="lg:col-span-2 bg-white border border-neutral-200 p-8 rounded-2xl shadow-pc-sm">
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-xl font-bold text-neutral-900">Subsidy Expenditure vs Fairness Gap</h3>
              <div className="flex gap-6">
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#1C8354]" /><span className="text-sm font-medium text-neutral-600">Expenditure (M SAR)</span></div>
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-gold-500" /><span className="text-sm font-medium text-neutral-600">FG Index (%)</span></div>
              </div>
            </div>
            <div className="h-[320px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={MONTHLY_TREND}>
                  <defs>
                    <linearGradient id="colorExpenditure" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#1C8354" stopOpacity={0.15}/>
                      <stop offset="95%" stopColor="#1C8354" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                  <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{fill: '#718096', fontSize: 13, fontWeight: 500}} dy={10} />
                  <YAxis yAxisId="left" axisLine={false} tickLine={false} tick={{fill: '#718096', fontSize: 13, fontWeight: 500}} dx={-10} />
                  <YAxis yAxisId="right" orientation="right" axisLine={false} tickLine={false} tick={{fill: '#718096', fontSize: 13, fontWeight: 500}} domain={[10, 20]} dx={10} />
                  <Tooltip 
                    contentStyle={{borderRadius: '12px', border: '1px solid #E2E8F0', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)'}}
                    itemStyle={{fontWeight: 600}}
                  />
                  <Area yAxisId="left" type="monotone" dataKey="expenditure" stroke="#1C8354" strokeWidth={3} fillOpacity={1} fill="url(#colorExpenditure)" />
                  <Line yAxisId="right" type="monotone" dataKey="fgIndex" stroke="#F59E0B" strokeWidth={3} dot={{r: 4, fill: '#F59E0B', strokeWidth: 2, stroke: '#fff'}} activeDot={{r: 6}} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Simulation Sidebar */}
          <div className="bg-white border border-neutral-200 p-8 rounded-2xl shadow-pc-sm flex flex-col justify-between">
            <div className="space-y-6">
              <div className="flex items-center gap-3 text-[#1C8354]">
                <div className="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center">
                  <FileText size={20} className="text-[#1C8354]" />
                </div>
                <h3 className="text-lg font-bold text-neutral-900">Policy Simulator</h3>
              </div>
              
              <div className="space-y-4">
                <div className="flex justify-between items-end">
                  <label className="text-sm font-bold text-neutral-600">Income Threshold</label>
                  <div className="text-2xl font-bold text-[#1C8354]">{threshold.toLocaleString()} <span className="text-sm text-neutral-400 font-medium ml-1">SAR</span></div>
                </div>
                <input 
                  type="range" min="5000" max="15000" step="500" value={threshold}
                  onChange={(e) => setThreshold(parseInt(e.target.value))}
                  disabled={simStage !== 'idle' && simStage !== 'completed'}
                  className="w-full h-2 bg-neutral-100 rounded-lg appearance-none cursor-pointer accent-[#1C8354]"
                />
              </div>

              {/* Real-time Orchestration Log */}
              <div className="bg-neutral-900 rounded-xl p-4 font-mono text-[11px] h-40 flex flex-col gap-2 overflow-hidden border border-neutral-800 shadow-inner">
                <div className="flex items-center gap-2 text-neutral-500 border-b border-neutral-800 pb-2 mb-1">
                  <Terminal size={12} />
                  <span>ORCHESTRATION_LOG_V2</span>
                </div>
                <div className="flex-1 flex flex-col gap-1.5 overflow-y-auto custom-scrollbar">
                  {logs.length === 0 && <div className="text-neutral-700 italic">Ready for simulation...</div>}
                  {logs.map((log, i) => (
                    <div key={i} className={`flex gap-2 animate-in fade-in slide-in-from-left-2 duration-300 ${
                      log.type === 'success' ? 'text-green-400' : 
                      log.type === 'agent' ? 'text-blue-400' : 'text-neutral-300'
                    }`}>
                      <span className="text-neutral-600 shrink-0">[{new Date().toLocaleTimeString([], {hour12: false})}]</span>
                      <span className="break-words">{log.msg}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <button 
              onClick={runSimulation} 
              disabled={simStage !== 'idle' && simStage !== 'completed'}
              className={`w-full py-4 mt-6 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 ${
                simStage !== 'idle' && simStage !== 'completed' 
                  ? 'bg-neutral-100 text-neutral-400 cursor-not-allowed' 
                  : 'bg-[#1C8354] text-white hover:bg-[#166943] shadow-lg active:scale-95'
              }`}
            >
              {simStage === 'idle' || simStage === 'completed' ? (
                <>
                  <Play size={16} fill="white" />
                  Apply Simulation
                </>
              ) : (
                <>
                  <div className="w-4 h-4 border-2 border-neutral-400 border-t-transparent rounded-full animate-spin" />
                  Agent Orchestration in Progress...
                </>
              )}
            </button>
          </div>
        </div>

        {/* Bottom Section: Multi-Agent & Alerts */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold text-neutral-900">Agent Orchestration (UC-SYS-01)</h3>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[#1C8354] bg-green-50 px-3 py-1 rounded-md">Multi-Agent System Active</span>
                {simStage !== 'idle' && simStage !== 'completed' && (
                   <span className="flex h-2 w-2 rounded-full bg-green-500 animate-ping" />
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4">
              {AGENTS.map(agent => (
                <div key={agent.id} className={`bg-white border p-5 rounded-xl flex items-center justify-between transition-all duration-500 ${
                  agent.status === 'Processing' ? 'border-[#1C8354] bg-green-50/30 ring-1 ring-[#1C8354]/10 shadow-md' : 'border-neutral-200 shadow-pc-sm'
                }`}>
                  <div className="flex items-center gap-5">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center transition-colors duration-500 ${
                      agent.status === 'Processing' ? 'bg-[#1C8354] text-white' : 
                      agent.status === 'Completed' ? 'bg-green-100 text-[#1C8354]' : 'bg-neutral-50 text-neutral-400'
                    }`}>
                      {agent.status === 'Completed' ? <CheckCircle2 size={24} /> : <Cpu size={24} className={agent.status === 'Processing' ? 'animate-pulse' : ''} />}
                    </div>
                    <div>
                      <div className="text-base font-bold text-neutral-900">{agent.name}</div>
                      <div className="text-sm text-neutral-500 mt-0.5">{agent.task}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-8">
                    <div className="text-right w-32">
                      <div className="text-[10px] text-neutral-400 font-bold uppercase mb-1.5">Agent Load</div>
                      <div className="h-1.5 bg-neutral-100 rounded-full overflow-hidden">
                        <div className={`h-full transition-all duration-1000 ${
                          agent.status === 'Processing' ? 'bg-[#1C8354]' : 'bg-neutral-300'
                        }`} style={{ width: `${agent.load}%` }} />
                      </div>
                    </div>
                    <div className={`w-24 text-center py-1.5 rounded text-xs font-bold transition-all duration-300 ${
                      agent.status === 'Processing' ? 'bg-[#1C8354] text-white' : 
                      agent.status === 'Completed' ? 'bg-green-100 text-[#1C8354]' : 'bg-neutral-100 text-neutral-500'
                    }`}>
                      {agent.status}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-6">
            <h3 className="text-xl font-bold text-neutral-900">Compliance & Alerts</h3>
            <div className="space-y-4">
              <div className="p-5 bg-red-50/50 border border-red-100 rounded-xl flex gap-4">
                <AlertCircle className="text-red-500 shrink-0 mt-0.5" size={20} />
                <div className="space-y-1.5">
                  <div className="text-sm font-bold text-red-900">Fairness Gap Deviation Detected</div>
                  <p className="text-sm text-red-800/80 leading-relaxed">Southern Region FG index dropped below the 15% baseline. Policy-Alignment-Agent recommends weight adjustment.</p>
                </div>
              </div>
              <div className="p-5 bg-gold-50/50 border border-gold-100 rounded-xl flex gap-4">
                <BarChart3 className="text-gold-600 shrink-0 mt-0.5" size={20} />
                <div className="space-y-1.5">
                  <div className="text-sm font-bold text-gold-900">Re-allocation Opportunity</div>
                  <p className="text-sm text-gold-800/80 leading-relaxed">Subsidy-Optimization-Agent identified 45M SAR available from dormant contracts for redistribution to Tier 1.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
