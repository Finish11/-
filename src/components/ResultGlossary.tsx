import React, { useState } from 'react';
import { BookOpen, ChevronRight, Info } from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { Button, Notice } from './ui/kit';

interface GlossaryEntry {
  id: string;
  term: string;
  short: string;
  explanation: string;
  example: string;
}

export const RESULT_GLOSSARY: GlossaryEntry[] = [
  {
    id: 'tspu',
    term: 'ТСПУ',
    short: 'Оборудование фильтрации у оператора',
    explanation:
      'Технические средства противодействия угрозам — оборудование, через которое оператор может ограничивать доступ к отдельным адресам или протоколам. По одному неоткрывшемуся сайту нельзя достоверно доказать, что виновато именно ТСПУ.',
    example: 'Если нейтральные сайты открываются, а отдельные ресурсы стабильно получают сброс или заглушку, это повод проверить фильтрацию повторно и другими адресами.',
  },
  {
    id: 'dpi',
    term: 'DPI',
    short: 'Анализ сетевого трафика',
    explanation:
      'Deep Packet Inspection — технология анализа пакетов и признаков соединения. Она может замедлять или разрывать отдельные протоколы. «Похоже на DPI» — гипотеза по совокупности признаков, а не показание напрямую с оборудования оператора.',
    example: 'Адрес существует и отвечает через другую сеть, но в текущей соединение обрывается на характерном этапе.',
  },
  {
    id: 'whitelist',
    term: 'Белые списки',
    short: 'Работает только разрешённый набор',
    explanation:
      'Режим, при котором доступны выбранные российские сервисы, а большая часть остального интернета не открывается. Поэтому мы сравниваем группы сайтов, а не делаем вывод по одному ресурсу.',
    example: 'Госуслуги и российские контрольные сайты отвечают, а Википедия и независимые зарубежные адреса одновременно недоступны.',
  },
  {
    id: 'shutdown',
    term: 'Шатдаун',
    short: 'Почти полное отключение внешней сети',
    explanation:
      'Ситуация, когда перестают отвечать и российские, и нейтральные зарубежные контрольные адреса. Это может быть отключение у оператора, авария или отсутствие интернета на телефоне — приложение различает только наблюдаемые признаки.',
    example: 'Проверка контрольной сети тоже не проходит; в таком случае вердикт по отдельным сайтам недостоверен.',
  },
  {
    id: 'vpn',
    term: 'VPN',
    short: 'Другой маршрут для трафика',
    explanation:
      'VPN направляет соединения через промежуточный сервер. Системный статус VPN показывает наличие туннеля, но не гарантирует, что каждый сервис заработает: провайдер сервиса может ограничивать страну выхода, аккаунт или дата-центровый IP.',
    example: 'Сайт открылся через VPN, но вход или отправка сообщения всё равно могут быть недоступны.',
  },
  {
    id: 'unrecognized',
    term: 'Ответ не распознан',
    short: 'Получен неожиданный HTML или заглушка',
    explanation:
      'Адрес что-то вернул, но ответ не похож на ожидаемую страницу сервиса: это могут быть антибот-проверка, операторская заглушка, страница ошибки или изменённый сайт. Это не означает «взлом» и не доказывает, что приложение не работает.',
    example: 'Для игры вместо официальной страницы пришёл HTML с Cloudflare — сетевой ответ есть, а содержимое не подтверждено.',
  },
  {
    id: 'tcp',
    term: 'TCP-connect',
    short: 'Время установления соединения, не ICMP ping',
    explanation:
      'Телефон пытается открыть TCP-соединение с host:port и измеряет время до результата. Через VPN клиент может принять соединение локально, поэтому субмиллисекундное значение не является доказанным RTT до сервера в другой стране.',
    example: '«<1 мс через VPN» описывает локальный/туннельный TCP-ответ, а не скорость пути до Нидерландов.',
  },
  {
    id: 'region',
    term: 'Ограничение сервиса',
    short: 'Доступ ограничил сам провайдер сервиса',
    explanation:
      'Некоторые сервисы официально поддерживают только перечисленные страны. Для ChatGPT, Claude и Gemini Россия отсутствует в таких списках. Это отличается от блокировки со стороны оператора или РКН.',
    example: 'HTML-заставка может скачиваться, но сервис не обязан разрешать регистрацию, вход и запросы из неподдерживаемой страны.',
  },
];

export const ResultGlossary: React.FC = () => {
  const [selected, setSelected] = useState<GlossaryEntry | null>(null);
  return (
    <>
      <div
        className="rounded-[1.5rem] border p-4"
        style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl grid place-items-center accent-soft">
            <BookOpen className="w-4.5 h-4.5" style={{ color: 'rgb(var(--accent))' }} />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-extrabold">Словарь результата</div>
            <div className="text-[10.5px] text-muted">Нажмите на непонятный термин</div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {RESULT_GLOSSARY.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setSelected(entry)}
              className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1.5 text-[10.5px] font-semibold tap"
              style={{ borderColor: 'rgb(var(--accent) / 0.24)', background: 'rgb(var(--accent) / 0.06)', color: 'var(--text)' }}
            >
              {entry.term}
              <ChevronRight className="w-3 h-3 text-muted" />
            </button>
          ))}
        </div>
      </div>

      <Sheet
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.term || 'Термин'}
        subtitle={selected?.short}
        size="sm"
        icon={<Info className="w-5 h-5" style={{ color: 'rgb(var(--accent))' }} />}
      >
        {selected && (
          <div className="space-y-3">
            <p className="text-[13px] leading-relaxed text-dim">{selected.explanation}</p>
            <Notice tone="info">
              <span><strong>Пример:</strong> {selected.example}</span>
            </Notice>
            <Button variant="primary" block onClick={() => setSelected(null)}>Понятно</Button>
          </div>
        )}
      </Sheet>
    </>
  );
};
