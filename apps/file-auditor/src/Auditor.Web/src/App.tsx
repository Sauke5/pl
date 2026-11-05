import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { appBase } from './api/client';
import { Shell } from './workspace/Shell';
import { OverviewPage, DepartmentsPage, DepartmentPage, DocumentsPage, ScansPage, ServicePage } from './workspace/Pages';

export default function App() {
  return <BrowserRouter basename={appBase || undefined}>
    <Shell>
      <Routes>
        <Route path="/" element={<OverviewPage/>}/>
        <Route path="/departments" element={<DepartmentsPage/>}/>
        <Route path="/departments/:id" element={<DepartmentPage/>}/>
        <Route path="/documents" element={<DocumentsPage/>}/>
        <Route path="/scans" element={<ScansPage/>}/>
        <Route path="/service" element={<ServicePage/>}/>
        <Route path="*" element={<Navigate to="/" replace/>}/>
      </Routes>
    </Shell>
  </BrowserRouter>;
}
