import { useState, useEffect } from 'react';
import { getApiBaseUrl } from '../config/api-config';
import { useTaskStore } from '../stores/taskStore';
import './SystemStats.css';

interface Stats {
  cpu: number;
  memory: {
    used: number;
    total: number;
    percent: number;
  };
}

export function SystemStats() {
  const isConnected = useTaskStore((s) => s.isConnected);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!isConnected) return;
    const fetchStats = async () => {
      try {
        const response = await fetch(`${getApiBaseUrl()}/api/system/stats`);
        if (response.ok) {
          const data = await response.json();
          setStats(data);
          setError(false);
        } else {
          setError(true);
        }
      } catch {
        setError(true);
      }
    };

    // Fetch immediately
    fetchStats();

    // Then poll every 2 seconds
    const interval = setInterval(fetchStats, 2000);

    return () => clearInterval(interval);
  }, [isConnected]);

  const formatBytes = (bytes: number): string => {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(1)}`;
  };

  const getCpuClass = () => {
    if (!stats) return '';
    if (stats.cpu <= 50) return 'stat-good';
    if (stats.cpu <= 80) return 'stat-medium';
    return 'stat-high';
  };

  const getMemoryClass = () => {
    if (!stats) return '';
    if (stats.memory.percent <= 60) return 'stat-good';
    if (stats.memory.percent <= 85) return 'stat-medium';
    return 'stat-high';
  };

  if (error || !stats) {
    return null;
  }

  return (
    <div className="system-stats">
      <div className={`stat-item ${getCpuClass()}`}>
        <span className="stat-value">{stats.cpu}%</span>
        <span className="stat-label">CPU</span>
      </div>
      <div className={`stat-item ${getMemoryClass()}`}>
        <span className="stat-value">{formatBytes(stats.memory.used)}G</span>
        <span className="stat-label">MEM</span>
      </div>
    </div>
  );
}
