// В бета-копии нет готовых тестов: каталог заполняется администратором вручную.
// Явный тип сохраняет совместимость со страницей обучения при пустом массиве.
export type TrainingTest = {
    id: string;
    title: string;
    subtitle: string;
    theory: string;
    quiz: Array<{
        q: string;
        o: string[];
        c: number;
    }>;
};

export const DEFAULT_TRAINING_TESTS: TrainingTest[] = [];
