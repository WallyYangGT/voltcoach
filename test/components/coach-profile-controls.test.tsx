/**
 * coach-profile-controls.test.tsx — L4 组件测试：「我的」页教练模式与时间预算控件。
 *
 * 钉住中间层行为（原需轻量冒烟）：模式三选一映射 null、每周时长档、可骑日多选回传
 * 星期编号、单次时长上限输入回传字符串。组件是纯受控展示，业务校验在 core/profile，
 * 此处只验交互接线。
 */
import React from 'react';
import { act, fireEvent, userEvent } from '@testing-library/react-native';
import { CoachProfileControls } from '@/components/CoachProfileControls';
import { renderWithProviders } from './helpers/render';

const baseProps = {
  coachMode: null as 'amateur' | 'standard' | null,
  weeklyHours: null as 'lt3' | '3to5' | '5to8' | 'gt8' | null,
  availableDays: [] as number[],
  sessionMax: '',
  onCoachModeChange: jest.fn(),
  onWeeklyHoursChange: jest.fn(),
  onToggleDay: jest.fn(),
  onSessionMaxChange: jest.fn(),
};

describe('CoachProfileControls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('点击「业余」回传 amateur；点击「未设置」回传 null', async () => {
    const screen = await renderWithProviders(<CoachProfileControls {...baseProps} />);
    await act(async () => {
      fireEvent.press(screen.getByText('业余'));
    });
    expect(baseProps.onCoachModeChange).toHaveBeenCalledWith('amateur');
    await act(async () => {
      fireEvent.press(screen.getByText('未设置'));
    });
    expect(baseProps.onCoachModeChange).toHaveBeenCalledWith(null);
  });

  it('点击每周时长档回传对应枚举', async () => {
    const screen = await renderWithProviders(<CoachProfileControls {...baseProps} />);
    await act(async () => {
      fireEvent.press(screen.getByText('3–5h'));
    });
    expect(baseProps.onWeeklyHoursChange).toHaveBeenCalledWith('3to5');
  });

  it('点击可骑日回传星期编号（1=周一 … 7=周日）', async () => {
    const screen = await renderWithProviders(<CoachProfileControls {...baseProps} />);
    await act(async () => {
      fireEvent.press(screen.getByText('三'));
    });
    expect(baseProps.onToggleDay).toHaveBeenCalledWith(3);
    await act(async () => {
      fireEvent.press(screen.getByText('日'));
    });
    expect(baseProps.onToggleDay).toHaveBeenCalledWith(7);
  });

  it('单次时长上限输入回传字符串草稿', async () => {
    // 受控组件：测试内用 state 承接草稿（与 me.tsx 的真实用法一致），否则输入框值不更新
    const onSessionMaxChange = jest.fn();
    function Harness() {
      const [v, setV] = React.useState('');
      return (
        <CoachProfileControls
          {...baseProps}
          sessionMax={v}
          onSessionMaxChange={(next) => {
            setV(next);
            onSessionMaxChange(next);
          }}
        />
      );
    }
    const screen = await renderWithProviders(<Harness />);
    await userEvent.type(screen.getByTestId('coach-session-max'), '90');
    expect(onSessionMaxChange).toHaveBeenCalled();
    expect(onSessionMaxChange.mock.calls.at(-1)?.[0]).toBe('90');
  });
});
