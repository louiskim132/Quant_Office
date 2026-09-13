import React from 'react';
import { Search } from 'lucide-react';

export function Empty({ icon: Icon, title, description, action }: { icon: React.ComponentType<{ size?: number; strokeWidth?: number }>; title: string; description: string; action?: React.ReactNode }) { return <div className="empty-state"><div className="empty-icon"><Icon size={29} strokeWidth={1.4}/></div><h2>{title}</h2><p>{description}</p>{action}</div>; }
export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (s: string) => void; placeholder: string }) { return <label className="search-field"><Search size={15}/><input aria-label={placeholder} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}/></label>; }
