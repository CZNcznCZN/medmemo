"""SM-2 间隔重复算法（SuperMemo 2，Anki 同款核心）。

输入：当前卡片的 (easiness, interval, repetition, 评分)
评分 quality（0-5）：
  0-2: 完全忘了  -> repetition 归零，明天再来
  3:   勉强想起 -> 进度停滞
  4:   良好     -> 正常推进
  5:   简单     -> 加速推进
输出：新的 (easiness, interval, repetition, 到期天数)
"""


def review(easiness, interval, repetition, quality):
    """根据评分更新 SM-2 状态。

    参数:
        easiness: 难度系数 EF，初值 2.5，下限 1.3
        interval: 当前间隔（天）
        repetition: 当前连续答对次数
        quality: 本次评分 0-5

    返回:
        (new_easiness, new_interval, new_repetition, days_until_due)
    """
    if quality < 3:
        # 没答对：归零，明天重练
        repetition = 0
        interval = 1
    else:
        # 答对了：按 SM-2 规则递增间隔
        if repetition == 0:
            interval = 1
        elif repetition == 1:
            interval = 6
        else:
            interval = round(interval * easiness)
        repetition += 1

    # 更新难度系数：答得好 EF 升，答得差 EF 降，下限 1.3
    easiness = easiness + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    if easiness < 1.3:
        easiness = 1.3

    return easiness, int(interval), repetition, int(interval)


# 评分档位映射：四按钮 -> SM-2 quality
# 用于前端「重记/困难/良好/简单」四档评分
RATING_TO_QUALITY = {
    "again": 1,   # 重记：完全忘了
    "hard": 3,    # 困难：勉强想起
    "good": 4,    # 良好：正常想起
    "easy": 5,    # 简单：秒答
}
